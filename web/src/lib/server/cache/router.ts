// Request router for the attic-compatible binary-cache API, dispatched from
// worker-entry.ts when a request arrives on the cache hostname. Fully native
// TypeScript — the legacy Rust worker is no longer involved.

import { observeRequest, measure } from './latency';
import { AsyncMemo } from './async-memo';
import {
	touchViaStore,
	loadCandidates,
	confirmCandidates,
	viaStore,
	stampClientIp,
	disposeLoopback,
	internalRequest,
	internalJson,
	remainingFreshMs
} from './metadata';
import {
	CacheConfigError,
	cacheInfo,
	configureCache,
	createCache,
	destroyCache,
	renameCache
} from './cache-config';
import { findCacheCached } from './cache-lookup';
import { handleAuthConfig, handleDeviceStart, handleDeviceToken } from './cli-auth';
import { readDeviceCode, readMissingPaths } from './request-input';
import { RequestBodyError, isRecord, JSON_LIMITS, readJson } from '../request-body';
import {
	AdmissionError,
	clientKey,
	enforceLimit,
	requireBudget,
	requireBudgetUnits
} from './admission';
import { checkRateLimit } from '../rate-limit';
import * as db from './db';
import { claimManualGcSlot, listPins, runGc } from './gc';
import {
	errorResponse,
	jsonResponse,
	logUnhandled,
	withCachePolicy,
	withVisibility
} from '../attic/http';
import {
	filterUpstreamPaths,
	findExistingPaths,
	upstreamNarRedirect,
	upstreamsForCache,
	type UpstreamNarRedirect
} from './missing-paths';
import type { ExecutionContext } from './platform';
import {
	getProxyKeypair,
	isKnownAbsent,
	pickReadableWinner,
	recordAbsent,
	shouldTouch,
	touchFailed
} from './proxy';
import { TtlMemo } from './ttl-memo';
import { persistUpstreamPath } from './pullthrough';
import { handleCacheList, handleDestroyPath, handleTokensApi } from './v1-admin';
import { edgeEvent, recordRead, UNIFIED_LABEL, type EdgeEvent } from './metrics';
import { extractPublicKey } from '../attic/signing';
import {
	keyedNarinfoUrl,
	narStoreUrl,
	PERSIST_CACHE_HEADER,
	PERSIST_UPSTREAM_HEADER,
	PREFETCH_MARKER_HEADER,
	serveStore,
	STORE_POLICY_VERSION,
	UPSTREAM_MARKER_HEADER,
	upstreamNarPath
} from './store';
import {
	hasGcAuthority,
	NO_PERMISSION,
	parseAuthToken,
	permissionForCache,
	verifyAtticToken,
	type Permission,
	type VerifiedToken
} from '../attic/token';
import {
	handleCdcChunkPut,
	handleCdcComplete,
	handleCdcQuery,
	admitUpload,
	handleUploadPath,
	validateManifest,
	type CdcManifest
} from './upload';

type Env = App.Platform['env'];

// Revocation freshness policy. High-volume transfer traffic (reads, uploads,
// batch queries) takes a per-isolate memo over a replica read: a CI fleet
// re-presents one token hundreds of times a second, and the memo TTL plus
// replica lag bounds how long a just-revoked token keeps moving bytes.
// Privileged operations (token mint/revoke, cache config, destroy, GC, pins)
// consult the primary on every call. A failed lookup never authenticates;
// public reads degrade to anonymous (authorizeCacheRead) rather than 503.
const REVOCATION_TTL_MS = 30_000;
const REVOCATION_MEMO_MAX_ENTRIES = 10_000;
const revocationMemo = new AsyncMemo<boolean>(REVOCATION_TTL_MS, REVOCATION_MEMO_MAX_ENTRIES);

// Per-isolate memo of successful signature verifications, keyed by the raw
// bearer string. A CI fleet re-presents one token for hundreds of pulls/sec,
// and each verification is a WebCrypto await (worst on RS256) — pure CPU
// repeated for an unchanged input. Only successes are memoized (a failure
// re-verifies, so transient key-import errors never stick), the entry TTL is
// capped by the token's own exp so expiry is still enforced to the second,
// and the revocation check below runs on memo hits too. Keys are whole JWTs
// (~1 KB), hence the smaller entry cap than the revocation memo.
const VERIFY_TTL_MS = 30_000;
const VERIFY_MEMO_MAX_ENTRIES = 2_000;
const verifiedTokens = new TtlMemo<VerifiedToken>(VERIFY_TTL_MS, VERIFY_MEMO_MAX_ENTRIES);

async function isJtiDisabled(env: Env, jti: string): Promise<boolean> {
	return revocationMemo.get(jti, () => db.isTokenDisabled(db.readSession(env.ATTIC_DB), jti));
}

/** Requests whose authorization must reflect the primary right now. */
function isPrivileged(request: Request): boolean {
	if (request.method === 'GET' || request.method === 'HEAD') return false;
	const path = new URL(request.url).pathname;
	return !path.startsWith('/_api/v1/upload-path') && path !== '/_api/v1/get-missing-paths';
}

/** Server-side misconfiguration surfaced during auth — must map to 500, not
 * 401: a 401 sends users chasing perfectly valid tokens. */
class MisconfigError extends Error {}

/** Response for a verifyRequestToken throw: 500 for server misconfig, else
 * 401 with the bare message (interpolating the Error object would render a
 * noisy "Authentication failed: Error: ..."). */
function authFailure(e: unknown): Response {
	if (e instanceof AdmissionError) return e.response();
	if (e instanceof MisconfigError) return errorResponse(500, e.message);
	return errorResponse(401, `Authentication failed: ${e instanceof Error ? e.message : e}`);
}

function verifyRequestToken(request: Request, env: Env): Promise<VerifiedToken | null> {
	return measure('auth', () => verifyRequestTokenInner(request, env));
}
async function verifyRequestTokenInner(request: Request, env: Env): Promise<VerifiedToken | null> {
	const bearer = parseAuthToken(request.headers.get('Authorization'));
	if (!bearer) return null;
	if (!env.JWT_HS256_SECRET_BASE64 && !env.JWT_RS256_PUBKEY_BASE64) {
		throw new MisconfigError('JWT secret not configured');
	}

	let token = verifiedTokens.get(bearer);
	if (!token) {
		token = await verifyAtticToken(
			bearer,
			{
				hs256SecretBase64: env.JWT_HS256_SECRET_BASE64,
				rs256PubkeyBase64: env.JWT_RS256_PUBKEY_BASE64
			},
			{
				issuer: env.JWT_BOUND_ISSUER || undefined,
				audiences: env.JWT_BOUND_AUDIENCES?.split(',').filter(Boolean)
			}
		);
		// Expire the memo entry no later than the token: a hit must never
		// outlive what a fresh verification would reject.
		const ttl =
			token.exp !== undefined
				? Math.min(VERIFY_TTL_MS, token.exp * 1000 - Date.now())
				: VERIFY_TTL_MS;
		if (ttl > 0) verifiedTokens.set(bearer, token, ttl);
	}

	if (token.jti) {
		let disabled: boolean;
		try {
			disabled = await (isPrivileged(request)
				? db.isTokenDisabled(env.ATTIC_DB, token.jti)
				: isJtiDisabled(env, token.jti));
		} catch {
			throw new AdmissionError('Authorization temporarily unavailable', 2);
		}
		if (disabled) throw new Error('Token has been revoked');
	}
	return token;
}

/**
 * Resolve a cache and authorize read access. Mirrors the reference server:
 * public caches grant anonymous pull (invalid tokens are ignored, not fatal),
 * and without any explicit grant for the name, both "no such cache" and
 * "permission denied" are masked as 401 to prevent cache enumeration.
 */
async function authorizeCacheRead(
	request: Request,
	env: Env,
	cacheName: string
): Promise<{ cache: db.CacheRow } | { response: Response }> {
	// The cache row is token-independent, so its lookup runs concurrently with
	// token verification: each is a replica round-trip on its memo-miss window
	// (the row read here, the jti revocation check inside verifyRequestToken),
	// and cold windows land on exactly the burst traffic where serializing them
	// showed up in the tail. Every path below awaits cachePromise, so a lookup
	// failure surfaces as before; the side .catch only marks the rejection
	// handled during the token-verification window so workerd doesn't report
	// it as unhandled in the interim.
	const cachePromise = findCacheCached(env.ATTIC_DB, cacheName, () =>
		requireBudget(env.BACKEND_READ_LIMITER, backendReadKey(request))
	);
	cachePromise.catch(() => {});
	let permission: Permission;
	let authError: unknown = null;
	try {
		const token = await verifyRequestToken(request, env);
		permission = permissionForCache(token, cacheName);
	} catch (e) {
		authError = e;
		permission = { ...NO_PERMISSION };
	}
	const hasDiscovery = Object.values(permission).some(Boolean);

	// Replica read, memoized per isolate: a cache-config change (e.g. visibility
	// flip) taking effect with replica lag — now bounded by the memo TTL rather
	// than sub-second — is acceptable for read authorization, and collapses the
	// per-path lookups of a mass-query burst to one row read per window.
	const cache = await cachePromise;
	if (!cache) {
		if (hasDiscovery) {
			return { response: errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache') };
		}
		return { response: errorResponse(401, 'Unauthorized') };
	}
	if (cache.is_public === 1) return { cache };
	if (authError) return { response: authFailure(authError) };
	if (permission.pull) return { cache };
	if (hasDiscovery) return { response: errorResponse(403, 'Permission denied: pull') };
	return { response: errorResponse(401, 'Unauthorized') };
}

async function handleNixCacheInfo(
	request: Request,
	env: Env,
	cacheName: string,
	head: boolean
): Promise<Response> {
	const auth = await authorizeCacheRead(request, env, cacheName);
	if ('response' in auth) return auth.response;
	const cache = auth.cache;

	if (head) return withVisibility(new Response(null, { status: 200 }), cache.is_public === 1);
	return withVisibility(
		new Response(`StoreDir: ${cache.store_dir}\nWantMassQuery: 1\nPriority: ${cache.priority}\n`, {
			status: 200,
			headers: { 'Content-Type': 'text/x-nix-cache-info' }
		}),
		cache.is_public === 1
	);
}

/**
 * Forward an authorized read to the CachedStore entrypoint (worker-entry.ts),
 * whose responses Workers Caching stores and serves at the edge. The
 * Authorization header is stripped so it never reaches the cache layer, where
 * it would trigger the automatic authenticated-request bypass — authorization
 * already happened here in the gateway, which runs on every request.
 *
 * Internal response headers are also handled here, uniformly for every store
 * route: the pull-through markers (see PERSIST_CACHE_HEADER) spawn the ingest
 * on THIS invocation's context — waitUntil work registered inside the
 * CachedStore RPC callee is cancelled when the RPC session ends, so the
 * download must ride the gateway, like the upload path's warms — and are
 * stripped so they never reach clients.
 */
let warnedStoreUnavailable = false;

async function forwardToStore(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined
): Promise<Response> {
	const storeUrl = new URL(request.url);
	if (storeUrl.pathname.endsWith('.narinfo'))
		storeUrl.searchParams.set('policy', STORE_POLICY_VERSION);
	const forwarded = new Request(storeUrl, request);
	forwarded.headers.delete('Authorization');
	forwarded.headers.delete('Cookie');
	stampClientIp(forwarded.headers, request.headers.get('CF-Connecting-IP'));
	// Internal prefetch-loopback marker (store.ts); client-supplied, it would
	// falsely mark the request as a prefetch and disable its upstream fallback.
	forwarded.headers.delete(PREFETCH_MARKER_HEADER);
	if (!ctx?.exports?.CachedStore && !warnedStoreUnavailable) {
		warnedStoreUnavailable = true;
		console.warn('ctx.exports.CachedStore unavailable; serving read path uncached');
	}
	const response = await measure('store', () =>
		viaStore(ctx, forwarded, () => serveStore(forwarded, env, ctx))
	);

	const cacheName = response.headers.get(PERSIST_CACHE_HEADER);
	const upstreamUrl = response.headers.get(PERSIST_UPSTREAM_HEADER);
	if (!cacheName || !upstreamUrl || response.status !== 200) return response;
	// The narinfo body is tiny, so buffering it to hand to the ingest is free.
	const text = await response.text();
	if (ctx?.waitUntil) {
		ctx.waitUntil(persistUpstreamPath(env, ctx, cacheName, upstreamUrl, text));
	}
	const stripped = new Response(text, response);
	stripped.headers.delete(PERSIST_CACHE_HEADER);
	stripped.headers.delete(PERSIST_UPSTREAM_HEADER);
	return stripped;
}

/** v1 routes with their own budgets instead of the per-IP API budget. */
const UNBUDGETED_V1_ROUTES = new Set(['upload-path', 'get-missing-paths', 'cli']);

function chargeApiBudget(request: Request, env: Env): Promise<Response | null> {
	const key = clientKey('api', request.headers.get('CF-Connecting-IP'));
	return enforceLimit(env, env.API_REQUEST_LIMITER, key, 'api');
}

/** Per jti; jti-less attic tokens fall back to subject plus client IP. */
function mutationKey(request: Request, token: VerifiedToken): string {
	if (token.jti) return `mutation:jti:${token.jti}`;
	return `mutation:sub:${token.sub ?? ''}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`;
}

/** Per-client key for cold gateway lookups (memo misses that reach D1). */
function backendReadKey(request: Request): string {
	return clientKey('backend-read', request.headers.get('CF-Connecting-IP'));
}

/** Edge-cache verdict of a store response, from the loopback's CF-Cache-Status. */
function storeEdge(response: Response): EdgeEvent {
	return edgeEvent(response.headers.get('CF-Cache-Status'));
}

/** Strip the internal upstream marker before a response leaves the gateway. */
function stripUpstreamMarker(response: Response): Response {
	if (!response.headers.has(UPSTREAM_MARKER_HEADER)) return response;
	const stripped = new Response(response.body, response);
	stripped.headers.delete(UPSTREAM_MARKER_HEADER);
	return stripped;
}

async function handleNarInfo(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheName: string,
	filename: string
): Promise<Response> {
	const storePathHash = filename.slice(0, -'.narinfo'.length);
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	const auth = await authorizeCacheRead(request, env, cacheName);
	if ('response' in auth) return auth.response;

	// The narinfo body embeds a signature from the cache keypair, so the edge
	// cache key must include the signing identity (keyedNarinfoUrl): rotating
	// the keypair makes every old entry unreachable immediately, instead of
	// relying on the best-effort tag purge (which cross_version_cache would
	// otherwise outlive across deploys). NARs are content-addressed and
	// signature-free, so they stay keyed by URL alone.
	const keyed = keyedNarinfoUrl(
		new URL(request.url).origin,
		cacheName,
		storePathHash,
		auth.cache.keypair
	);
	const response = await forwardToStore(new Request(keyed, request), env, ctx);
	recordRead(env, 'narinfo', cacheName, {
		status: response.status,
		viaUpstream: response.headers.has(UPSTREAM_MARKER_HEADER),
		edge: storeEdge(response)
	});
	return withCachePolicy(stripUpstreamMarker(response), auth.cache.is_public === 1);
}

/** A NAR this route cannot serve: redirect to the cache's upstreams (the
 * union of live caches' upstreams for the root) or 404, recording the read
 * either way. `notFound` lets a store 404 pass through unchanged. */
async function narMiss(
	env: Env,
	ctx: ExecutionContext | undefined,
	request: Request,
	cache: { id: number; name: string } | null,
	filename: string,
	label: string,
	edge: EdgeEvent,
	notFound?: Response
): Promise<Response> {
	const upstreamUrl = await resolveUpstreamNar(env, ctx, request, cache, filename);
	return finishNarMiss(env, label, edge, upstreamUrl, notFound);
}

/** The upstream NAR redirect target, or null for a confirmed upstream miss.
 * Upstream uncertainty throws (a retryable AdmissionError). Records nothing. */
function resolveUpstreamNar(
	env: Env,
	ctx: ExecutionContext | undefined,
	request: Request,
	cache: { id: number; name: string } | null,
	filename: string
): Promise<string | null> {
	const path = upstreamNarPath(cache, filename);
	return measure('upstreamRedirect', () =>
		upstreamNarRedirect(path, () =>
			loadUpstreamNar(env, ctx, path, request.headers.get('CF-Connecting-IP'))
		)
	);
}

/** Record a resolved NAR miss once and answer it: a redirect or a 404. */
async function finishNarMiss(
	env: Env,
	label: string,
	edge: EdgeEvent,
	upstreamUrl: string | null,
	notFound?: Response
): Promise<Response> {
	recordRead(env, 'nar', label, {
		status: upstreamUrl ? 302 : 404,
		viaUpstream: !!upstreamUrl,
		edge
	});
	if (upstreamUrl) {
		await disposeLoopback(notFound);
		return Response.redirect(upstreamUrl, 302);
	}
	return notFound ?? errorResponse(404, 'Not found', 'NoSuchObject');
}

/** The upstream redirect target for a NAR no local cache serves, through the
 * store's edge-cached resolver (serveUpstreamNar). */
async function loadUpstreamNar(
	env: Env,
	ctx: ExecutionContext | undefined,
	path: string,
	ip: string | null
): Promise<UpstreamNarRedirect> {
	const internal = internalRequest(env, path, ip);
	const response = await viaStore(ctx, internal, () => serveStore(internal, env, ctx));
	const freshMs = remainingFreshMs(response.headers);
	return {
		url: await internalJson<string | null>(response, 'Upstream temporarily unavailable'),
		freshMs
	};
}

/** Retention is download-driven (like the reference server): touch every
 * object in the cache backed by the NAR, off the critical path. This must
 * happen in the gateway — downloads served from the edge cache never reach
 * the CachedStore entrypoint — and only after the store confirmed the NAR
 * exists: touching before the read gave nonexistent-hash floods a free
 * primary write per request, while real NARs stay coalesced by shouldTouch. */
function scheduleTouch(
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheId: number,
	narHashRaw: string
): void {
	if (!shouldTouch(cacheId, narHashRaw)) return;
	ctx?.waitUntil(
		touchViaStore(env, ctx, cacheId, narHashRaw).catch(() => touchFailed(cacheId, narHashRaw))
	);
}

async function handleNar(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheName: string,
	filename: string,
	head: boolean
): Promise<Response> {
	const narHashRaw = filename.split('.')[0];
	if (!narHashRaw) return errorResponse(400, 'Invalid NAR path');

	const auth = await authorizeCacheRead(request, env, cacheName);
	if ('response' in auth) return auth.response;

	// Public caches share one content-addressed edge key, so the body of a NAR
	// this cache no longer holds (or never held — a hash learned from a cache
	// that since went private) may still be cached under it. Reading a public
	// cache therefore requires the cache to hold the NAR *now*, per the cached
	// candidate metadata, before the shared key is touched; the year-long body
	// entry is then only reachable while some public cache currently holds
	// it, whether or not the withdrawal purge succeeded. Private caches use a
	// key scoped to their id, which authorizeCacheRead already covers.
	if (auth.cache.is_public === 1) {
		const holds = (rows: db.LiveCacheRow[]) => rows.some((c) => c.id === auth.cache.id);
		let holders = (
			await measure('candidates', () => loadCandidates(env, ctx, request, 'nar', narHashRaw))
		).rows;
		// Not listed: either really absent or a stale entry from before this
		// cache received the NAR — confirm before refusing. That includes an
		// empty entry: the upload's candidate purge is only queued (paced, and
		// deferred further under rate limits), so the entry can outlive the
		// upload by its full TTL. confirmCandidates is memoized per hash and
		// budgeted, bounding the primary reads for upstream-only NARs.
		if (!holds(holders))
			holders = await measure('candidates', () =>
				confirmCandidates(env, ctx, request, 'nar', narHashRaw, holders)
			);
		if (!holds(holders)) return narMiss(env, ctx, request, auth.cache, filename, cacheName, 'none');
	}

	// narStoreUrl owns the edge key (content-addressed for public caches,
	// cache-scoped for private). The cache-specific concerns stay here: the
	// visibility header is stamped per request, and a store miss falls back to
	// the cache's upstreams (passthrough narinfo NAR URLs resolve that way).
	const keyed = narStoreUrl(request, auth.cache, filename);
	const response = await forwardToStore(new Request(keyed, request), env, ctx);

	if (response.status === 404)
		return narMiss(
			env,
			ctx,
			request,
			auth.cache,
			filename,
			cacheName,
			storeEdge(response),
			response
		);

	if (!head && response.ok) scheduleTouch(env, ctx, auth.cache.id, narHashRaw);
	recordRead(env, 'nar', cacheName, { status: response.status, edge: storeEdge(response) });
	return withCachePolicy(
		withVisibility(new Response(response.body, response), auth.cache.is_public === 1),
		auth.cache.is_public === 1
	);
}

// --- root proxy (read-only): resolve across the requester's readable caches,
// then fall back to the union of live caches' upstreams on a miss ------------

function handleProxyNixCacheInfo(head: boolean): Response {
	if (head) return new Response(null, { status: 200 });
	return new Response('StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n', {
		status: 200,
		headers: { 'Content-Type': 'text/x-nix-cache-info' }
	});
}

/** Invalid tokens degrade to anonymous, like authorizeCacheRead on public reads. */
async function proxyToken(request: Request, env: Env): Promise<VerifiedToken | null> {
	try {
		return await verifyRequestToken(request, env);
	} catch {
		return null;
	}
}

/** A settled promise, so a failure can wait on a confirmation before it
 * decides the answer. */
type Settled<T> =
	{ ok: true; value: T; error?: never } | { ok: false; value?: never; error: unknown };
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error })
	);
}

async function handleProxyNarInfo(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	filename: string
): Promise<Response> {
	const storePathHash = filename.slice(0, -'.narinfo'.length);
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	// Known-absent paths short-circuit before any token or D1 work: absence is
	// token-independent, and mass queries re-ask for every miss.
	if (isKnownAbsent(storePathHash)) {
		recordRead(env, 'narinfo', UNIFIED_LABEL, { status: 404, edge: 'memo' });
		return errorResponse(404, 'Not found', 'NoSuchObject');
	}

	// Token verification (CPU plus, at worst, a memoized revocation read) and
	// candidate resolution (an edge-cached /_meta loopback) are independent —
	// run them concurrently. The candidates' edge entry is what keeps edge hits
	// off D1: the winner determines the edge key, so this resolution runs on
	// every root read, cached or not.
	const [token, cached] = await Promise.all([
		proxyToken(request, env),
		measure('candidates', () => loadCandidates(env, ctx, request, 'path', storePathHash))
	]);
	let candidates = cached.rows;
	let winner = pickReadableWinner(token, candidates);
	// Caches listed but none readable (or none left after the visibility
	// filter): the common case is a private-only path, but a stale positive
	// entry would also look like this after the path landed in a public
	// cache — confirm before falling back. An empty entry is short-lived and
	// is confirmed only if it was served stale and the upstreams miss too.
	if (!winner && cached.listed) {
		candidates = await measure('candidates', () =>
			confirmCandidates(env, ctx, request, 'path', storePathHash, candidates)
		);
		winner = pickReadableWinner(token, candidates);
	}
	// No local winner (not stored anywhere, or stored only in caches this
	// requester can't read): fall back to the union of live caches' upstreams.
	// Upstream content is public, so serving it regardless of token leaks
	// nothing; not-found and not-readable both end as 404 — the root names no
	// caches, so there is nothing to enumerate.
	if (!winner) {
		const fallback = new URL(
			`${new URL(request.url).origin}/_proxy_upstream/${storePathHash}.narinfo`
		);
		// Upstream content is the fast path; a stale empty entry is confirmed
		// before a miss or an upstream failure — returned or thrown — becomes
		// the answer.
		const upstream = await settle(forwardToStore(new Request(fallback, request), env, ctx));
		const response = upstream.value;
		if (!response?.ok) {
			const confirmed = await measure('candidates', cached.confirmEmpty).catch(async (e) => {
				await disposeLoopback(response);
				throw e;
			});
			if (confirmed) {
				candidates = confirmed;
				winner = pickReadableWinner(token, candidates);
			}
		}
		if (winner) {
			await disposeLoopback(response);
		} else if (!response) {
			throw upstream.error;
		} else if (response.status === 404) {
			// The absent memo is token-independent, so only an empty candidate
			// set (nothing local for anyone) plus an upstream miss may record it.
			if (candidates.length === 0) recordAbsent(storePathHash);
			recordRead(env, 'narinfo', UNIFIED_LABEL, { status: 404, edge: storeEdge(response) });
			await disposeLoopback(response);
			return errorResponse(404, 'Not found', 'NoSuchObject');
		} else {
			// A 200 here is upstream content served through the union fallback.
			recordRead(env, 'narinfo', UNIFIED_LABEL, {
				status: response.status,
				viaUpstream: true,
				edge: storeEdge(response)
			});
			return withCachePolicy(stripUpstreamMarker(response), true);
		}
	}

	let pk: string | null = null;
	try {
		pk = extractPublicKey(await measure('proxyKeypair', () => getProxyKeypair(env)));
	} catch {
		// keypair unavailable: serve unsigned/stored-sig variant unkeyed
	}
	const fetchWinner = (from: db.LiveCacheRow) => {
		const keyed = new URL(
			`${new URL(request.url).origin}/_proxy/${from.name}/${storePathHash}.narinfo`
		);
		if (pk) keyed.searchParams.set('pk', pk);
		return forwardToStore(new Request(keyed, request), env, ctx);
	};
	let response = await fetchWinner(winner);
	// The winner no longer holds the path (reaped, or a stale positive
	// entry): confirm and retry once against whoever holds it now.
	if (response.status === 404) {
		const next = pickReadableWinner(
			token,
			await measure('candidates', () =>
				confirmCandidates(env, ctx, request, 'path', storePathHash, candidates)
			)
		);
		if (next && next.id !== winner.id) {
			await disposeLoopback(response);
			winner = next;
			response = await fetchWinner(winner);
		}
	}
	recordRead(env, 'narinfo', UNIFIED_LABEL, { status: response.status, edge: storeEdge(response) });
	return withCachePolicy(response, winner.is_public === 1);
}

async function handleProxyNar(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	filename: string,
	head: boolean
): Promise<Response> {
	const narHashRaw = filename.split('.')[0];
	if (!narHashRaw) return errorResponse(400, 'Invalid NAR path');

	// Same concurrent shape (and memo rationale) as handleProxyNarInfo above.
	const [token, cached] = await Promise.all([
		proxyToken(request, env),
		measure('candidates', () => loadCandidates(env, ctx, request, 'nar', narHashRaw))
	]);
	let narCandidates = cached.rows;
	let winner = pickReadableWinner(token, narCandidates);
	// Same stale-positive guard as handleProxyNarInfo.
	if (!winner && cached.listed) {
		narCandidates = await measure('candidates', () =>
			confirmCandidates(env, ctx, request, 'nar', narHashRaw, narCandidates)
		);
		winner = pickReadableWinner(token, narCandidates);
	}
	// NAR URLs served by root-proxy upstream passthrough narinfos resolve here
	// with no local winner, so the root needs the same upstream redirect as the
	// per-cache route — against the union of live caches' upstreams. A stale
	// empty entry is confirmed only if that misses too: upstream-only NARs are
	// most of this route and must not each cost a D1 read.
	if (!winner) {
		const upstream = await settle(resolveUpstreamNar(env, ctx, request, null, filename));
		if (!upstream.value) {
			const confirmed = await measure('candidates', cached.confirmEmpty);
			if (confirmed) {
				narCandidates = confirmed;
				winner = pickReadableWinner(token, narCandidates);
			}
		}
		if (!winner) {
			if (!upstream.ok) throw upstream.error;
			return finishNarMiss(env, UNIFIED_LABEL, 'none', upstream.value);
		}
	}

	// Same edge entry as the per-cache route. pickReadableWinner already proved
	// the winner holds this NAR, but the scoped path is what keeps the resulting
	// edge entry out of reach of a request authorized against another cache.
	let response = await forwardToStore(
		new Request(narStoreUrl(request, winner, filename), request),
		env,
		ctx
	);
	// The winner no longer holds the NAR (GC reaped it, or the candidate
	// entry was a stale positive): confirm and retry once against whoever
	// holds it now before falling back to the upstreams.
	if (response.status === 404) {
		const next = pickReadableWinner(
			token,
			await measure('candidates', () =>
				confirmCandidates(env, ctx, request, 'nar', narHashRaw, narCandidates)
			)
		);
		if (next && next.id !== winner.id) {
			await disposeLoopback(response);
			winner = next;
			response = await forwardToStore(
				new Request(narStoreUrl(request, winner, filename), request),
				env,
				ctx
			);
		}
	}
	if (!head && response.ok) scheduleTouch(env, ctx, winner.id, narHashRaw);
	if (response.status === 404)
		return narMiss(env, ctx, request, null, filename, UNIFIED_LABEL, storeEdge(response), response);
	recordRead(env, 'nar', UNIFIED_LABEL, { status: response.status, edge: storeEdge(response) });
	return withCachePolicy(
		withVisibility(new Response(response.body, response), winner.is_public === 1),
		winner.is_public === 1
	);
}

/**
 * POST /_api/v1/get-missing-paths — which of the client's closure hashes need
 * uploading. Requires push permission. Paths present in the cache's configured
 * upstreams (e.g. cache.nixos.org) are excluded so clients never push them,
 * unless the request opts out with ignore_upstream_cache_filter.
 */
async function handleGetMissingPaths(
	request: Request,
	env: Env,
	ctx?: ExecutionContext
): Promise<Response> {
	let token: VerifiedToken | null;
	try {
		token = await verifyRequestToken(request, env);
	} catch (e) {
		return authFailure(e);
	}
	if (!token) return errorResponse(401, 'No token provided');

	const body = await readMissingPaths(request);
	if (!permissionForCache(token, body.cache).push) {
		return errorResponse(403, 'Permission denied: push');
	}
	// One unit per request plus one per started 1000 hashes, charged
	// together and per client: a full 10k batch (what the Go client sends)
	// is 11 units, a 50k stock-attic closure 51, so the limit is expressed in requests, not hash windows,
	// and one pusher's burst cannot exhaust the colo for everyone else.
	await requireBudgetUnits(
		env.BATCH_QUERY_LIMITER,
		clientKey('batch-query', request.headers.get('CF-Connecting-IP')),
		1 + Math.ceil(body.hashes.length / 1000)
	);

	// Replica reads throughout: staleness at worst re-reports a just-pushed
	// path as missing, and the upload path dedups the re-push. Keeps this
	// run-start read burst (nix-fast-build checks every path up front) off the
	// write primary, which is where the push writes contend. The cache row
	// rides the same memo as the serve and upload paths.
	//
	// The three reads are only partially dependent — the existing-paths scan
	// keys on the cache NAME while the upstream list needs the row — so the
	// scan overlaps both the row lookup and the upstream read instead of
	// serializing three replica round-trips. Side .catch marks the scan's
	// rejection handled while the row lookup is outstanding; the real await
	// below still rethrows it. A missing-cache return drains the speculative
	// scan so no binding work outlives the request.
	const session = db.readSession(env.ATTIC_DB);
	const hashes = body.hashes;
	const existingPromise = findExistingPaths(session, body.cache, hashes);
	existingPromise.catch(() => {});
	const cache = await findCacheCached(env.ATTIC_DB, body.cache);
	if (!cache) {
		await existingPromise.catch(() => {});
		return errorResponse(404, `Cache not found: ${body.cache}`, 'NoSuchCache');
	}

	const upstreams = body.ignoreUpstream ? [] : await upstreamsForCache(session, cache);
	const existing = await existingPromise;
	const missing = hashes.filter((h) => !existing.has(h));
	// deferred_paths: the subset of missing_paths no upstream could be asked
	// about within this request's probe budget. attic clients ignore the field
	// and push them; the nimbus client re-queries them first.
	const filtered =
		upstreams.length > 0 && missing.length > 0
			? await filterUpstreamPaths(
					session,
					upstreams,
					missing,
					{
						env,
						ip: request.headers.get('cf-connecting-ip')
					},
					ctx
				)
			: { missing, deferred: [] };

	return new Response(
		JSON.stringify({ missing_paths: filtered.missing, deferred_paths: filtered.deferred }),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		}
	);
}

/**
 * POST /_api/v1/gc — manual GC trigger, authorized by hasGcAuthority (the
 * nimbus gc claim, or attic-native delete on `*`). `?dry_run=1` reports what
 * retention would delete without deleting.
 */
async function handleGcTrigger(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	url: URL
): Promise<Response> {
	let token: VerifiedToken | null;
	try {
		token = await verifyRequestToken(request, env);
	} catch (e) {
		return authFailure(e);
	}
	if (!token) return errorResponse(401, 'No token provided');
	// The nimbus gc claim is minted admin-only from the tokens page (it is
	// storage-wide, so it is never a per-cache grant).
	if (!hasGcAuthority(token)) {
		return errorResponse(403, 'Permission denied: garbage collection');
	}
	// After authorization, so an unauthorized flood cannot lock admins out.
	const limited = await enforceLimit(env, env.GC_TRIGGER_LIMITER, 'gc', 'gc');
	if (limited) return limited;
	const retryAfter = await claimManualGcSlot(env.ATTIC_DB);
	if (retryAfter !== null) {
		return errorResponse(429, 'A manual GC ran recently; retry later', undefined, {
			'Retry-After': String(retryAfter)
		});
	}

	const dryRun = url.searchParams.get('dry_run') === '1';
	const stats = await runGc(env, { dryRun, ctx });
	return new Response(JSON.stringify(dryRun ? { ...stats, dry_run: 1 } : stats), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * GET /{cache}/attic-cache-info and GET /_api/v1/cache-config/{cache}. Like
 * the reference server this requires pull (anonymous on public caches) — the
 * discovery document exposes the public key and settings.
 */
async function handleCacheInfo(
	request: Request,
	env: Env,
	cacheName: string,
	baseUrl: string
): Promise<Response> {
	const auth = await authorizeCacheRead(request, env, cacheName);
	if ('response' in auth) return auth.response;
	return withVisibility(jsonResponse(cacheInfo(auth.cache, baseUrl)), auth.cache.is_public === 1);
}

/** The shared gc-root/pin POST body; throws RequestBodyError (400). */
async function readRootBody(
	request: Request
): Promise<{ body: Record<string, unknown>; hash: string; note: string | null }> {
	const body = await readJson(request, JSON_LIMITS.gcRoot);
	if (!isRecord(body)) throw new RequestBodyError(400, 'Invalid request body');
	const hash = body.store_path_hash;
	if (typeof hash !== 'string' || !db.STORE_PATH_HASH_RE.test(hash)) {
		throw new RequestBodyError(400, 'Invalid store path hash');
	}
	const note = body.note ?? null;
	if (note !== null && typeof note !== 'string') throw new RequestBodyError(400, 'Invalid note');
	return { body, hash, note };
}

/** Require an authenticated token; returns a Response on failure. */
async function requireToken(
	request: Request,
	env: Env
): Promise<{ token: VerifiedToken } | { response: Response }> {
	try {
		const token = await verifyRequestToken(request, env);
		if (!token) return { response: errorResponse(401, 'No token provided') };
		return { token };
	} catch (e) {
		return { response: authFailure(e) };
	}
}

/**
 * Convert a thrown error at a request boundary into a client response.
 * CacheConfigError is an expected client-facing error and passes through
 * verbatim. Everything else is logged with a ref id — the client gets a
 * stable message carrying the ref, the stack stays in Workers Logs — and
 * transient D1 errors that outlived the query-layer retries map to 503 +
 * Retry-After so clients back off and retry instead of treating an
 * infrastructure blip as fatal. Shared with the CachedStore boundary in
 * worker-entry.ts so both halves speak one retryability contract.
 */
export function caughtResponse(prefix: string, request: Request, e: unknown): Response {
	if (e instanceof AdmissionError) return e.response();
	if (e instanceof RequestBodyError) return e.response();
	if (e instanceof CacheConfigError) {
		return errorResponse(e.status, e.message, e.status === 404 ? 'NoSuchCache' : undefined);
	}
	const ref = crypto.randomUUID().slice(0, 8);
	logUnhandled(`${prefix} [${ref}]`, request, e);
	if (db.isTransientD1Error(e)) {
		return errorResponse(
			503,
			`Temporary database contention; retry shortly (ref ${ref})`,
			undefined,
			{
				'Retry-After': '2'
			}
		);
	}
	return errorResponse(500, `Internal server error (ref ${ref})`);
}

/** /_api/v1/cache-config/:cache[/rename] and the upload endpoints. */
async function handleV1(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	url: URL,
	segments: string[]
): Promise<Response> {
	const method = request.method;
	const route = segments[2];

	// Before token verification, so invalid-signature floods pay too.
	if (!UNBUDGETED_V1_ROUTES.has(route)) {
		const limited = await chargeApiBudget(request, env);
		if (limited) return limited;
	}

	// Unauthenticated discovery endpoints.
	if (method === 'GET' && route === 'auth-config' && segments.length === 3) {
		return handleAuthConfig(env);
	}
	if (method === 'POST' && route === 'cli' && segments.length === 4) {
		if (segments[3] === 'device') {
			const limited = await checkRateLimit(request, env.DEVICE_START_LIMITER);
			if (limited) return limited;
			const globalLimit = await checkRateLimit(
				request,
				env.DEVICE_START_GLOBAL_LIMITER,
				'device-start'
			);
			if (globalLimit) return globalLimit;
			return handleDeviceStart(env);
		}
		if (segments[3] === 'token') {
			const limited = await checkRateLimit(request, env.DEVICE_AUTH_LIMITER);
			if (limited) return limited;
			return handleDeviceToken(env, await readDeviceCode(request));
		}
	}
	if (method === 'GET' && route === 'cache-config' && segments.length === 4) {
		return handleCacheInfo(request, env, segments[3], apiBase(env, url));
	}
	if (method === 'GET' && route === 'caches' && segments.length === 3) {
		// Optional auth, like the read path: an invalid token degrades to
		// anonymous (public caches only) rather than failing the request.
		let token: VerifiedToken | null = null;
		try {
			token = await verifyRequestToken(request, env);
		} catch {
			token = null;
		}
		return handleCacheList(env, token, () =>
			requireBudget(env.BACKEND_READ_LIMITER, backendReadKey(request))
		);
	}

	if (method === 'POST' && route === 'get-missing-paths' && segments.length === 3) {
		return handleGetMissingPaths(request, env, ctx);
	}
	if (method === 'POST' && route === 'gc' && segments.length === 3) {
		return handleGcTrigger(request, env, ctx, url);
	}

	// Everything below requires a token.
	const auth = await requireToken(request, env);
	if ('response' in auth) return auth.response;
	const token = auth.token;
	const canPush = (cacheName: string) => permissionForCache(token, cacheName).push;

	// Every write below except uploads (own budgets), so new routes are covered.
	if (method !== 'GET' && method !== 'HEAD' && route !== 'upload-path') {
		const limited = await enforceLimit(
			env,
			env.API_MUTATION_LIMITER,
			mutationKey(request, token),
			'mutation'
		);
		if (limited) return limited;
	}

	// nimbus extension: token self-service (mint/list/revoke as the user
	// behind the presented token's jti).
	if (route === 'tokens' && (segments.length === 3 || segments.length === 4)) {
		return handleTokensApi(request, env, token);
	}

	// nimbus extension: closure-safe per-path destroy (the API face of the
	// dashboard's prune action).
	if (method === 'DELETE' && route === 'path' && segments.length === 5) {
		return handleDestroyPath(env, ctx, segments[3], decodeURIComponent(segments[4]), token);
	}

	if (route === 'upload-path') {
		if (![...token.caches.values()].some((permission) => permission.push)) {
			return errorResponse(403, 'Permission denied: push');
		}
		await requireBudget(env.UPLOAD_LIMITER, 'upload');
		// The CDC endpoints are stateless, so authorization rides along on each
		// request: the manifest body carries the cache for POSTs, and chunk PUTs
		// carry it as a query param. Provenance is stamped server-side —
		// client-supplied source/created_by fields are overwritten.
		const parseManifest = async (): Promise<CdcManifest | Response> => {
			const body = (await readJson(request, 1024 * 1024)) as CdcManifest;
			const invalid = validateManifest(body);
			if (invalid) return invalid;
			if (!canPush(body.nar_info.cache)) return errorResponse(403, 'Permission denied: push');
			body.nar_info.publishTrust = undefined;
			body.nar_info.source = 'push';
			body.nar_info.created_by = token.sub ?? null;
			return body;
		};

		// Size-budget enforcement runs on the nightly GC cron (scheduled →
		// runGc), not inline here: the budget check (a SUM over chunk) plus a
		// possible full GC hit the D1 write primary, and firing that from every
		// upload starved concurrent pushes' writes — tipping the primary's queue
		// into "D1 requests queued for too long". The tradeoff is that a size
		// budget can be exceeded for up to a day between cron runs.
		//
		// Only bodies that get buffered or decompressed take the memory slot:
		// the CDC manifests are ≤1 MiB JSON; gating them behind chunk PUTs
		// stalled the client's pipeline.
		// Completion re-reads chunks one at a time under wasmMemorySlots, so
		// it takes no upload slot: holding one for a multi-GB verification
		// would let two completions stall every push on the isolate.
		const narRoute =
			method !== 'PUT'
				? null
				: segments.length === 3
					? 'path'
					: segments[3] === 'chunks' && segments.length === 5
						? 'chunk'
						: null;
		const release = narRoute ? await admitUpload(request, narRoute) : null;
		try {
			if (method === 'PUT' && segments.length === 3) {
				const response = await handleUploadPath(request, env, ctx, canPush, token.sub ?? null);
				return isAtticClient(request) ? await atticUploadKind(response) : response;
			} else if (method === 'POST' && segments[3] === 'chunks' && segments.length === 4) {
				const manifest = await parseManifest();
				if (manifest instanceof Response) return manifest;
				return await handleCdcQuery(
					env,
					ctx,
					manifest,
					(cacheName) => permissionForCache(token, cacheName).pull
				);
			} else if (method === 'PUT' && segments[3] === 'chunks' && segments.length === 5) {
				const cacheName = url.searchParams.get('cache');
				if (!cacheName) return errorResponse(400, 'Missing cache parameter');
				if (!canPush(cacheName)) return errorResponse(403, 'Permission denied: push');
				return await handleCdcChunkPut(request, env, segments[4], cacheName, ctx);
			} else if (
				method === 'POST' &&
				segments[3] === 'chunks' &&
				segments[4] === 'complete' &&
				segments.length === 5
			) {
				const manifest = await parseManifest();
				if (manifest instanceof Response) return manifest;
				return await handleCdcComplete(env, ctx, manifest);
			}
			return errorResponse(404, 'Not found');
		} finally {
			release?.();
		}
	}

	// nimbus extension: GC roots (pin/unpin) over the API. Pinning is a
	// retention decision, so it takes the same permissions as retention config.
	if (route === 'gc-root' && (segments.length === 4 || segments.length === 5)) {
		const cacheName = segments[3];
		const permission = permissionForCache(token, cacheName);
		if (!permission.configureCacheRetention && !permission.configureCache) {
			return errorResponse(403, 'Permission denied: configure cache retention');
		}
		const cache = await db.findCache(env.ATTIC_DB, cacheName);
		if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');

		if (method === 'POST' && segments.length === 4) {
			const { hash, note } = await readRootBody(request);
			await db.addGcRoot(env.ATTIC_DB, cache.id, hash, note);
			return jsonResponse({ pinned: hash });
		}
		if (method === 'DELETE' && segments.length === 5) {
			const hash = segments[4];
			if (!/^[0-9a-z]{32}$/.test(hash)) return errorResponse(400, 'Invalid store path hash');
			const removed = await db.removeGcRoot(env.ATTIC_DB, cache.id, hash);
			if (!removed) return errorResponse(404, 'Path is not pinned');
			return jsonResponse({ unpinned: hash });
		}
		return errorResponse(404, 'Not found');
	}

	// nimbus extension: named pins (cachix-style) — a pin name whose gc_root
	// rows are its revision history. Same permission rule as gc-root above.
	if (route === 'pin' && (segments.length === 4 || segments.length === 5)) {
		const cacheName = segments[3];
		const permission = permissionForCache(token, cacheName);
		if (!permission.configureCacheRetention && !permission.configureCache) {
			return errorResponse(403, 'Permission denied: configure cache retention');
		}
		const cache = await db.findCache(env.ATTIC_DB, cacheName);
		if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');

		if (method === 'GET' && segments.length === 4) {
			return jsonResponse({ pins: await listPins(env, cache.id) });
		}
		if (method === 'POST' && segments.length === 4) {
			const { body, hash, note } = await readRootBody(request);
			const name = typeof body.name === 'string' ? body.name.trim() : '';
			if (!db.PIN_NAME_RE.test(name)) {
				return errorResponse(400, 'Invalid pin name (1-100 chars, no whitespace)');
			}
			const keep = (v: unknown) =>
				typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
			await db.upsertPin(env.ATTIC_DB, cache.id, name, hash, {
				keepRevisions: keep(body.keep_revisions),
				keepDays: keep(body.keep_days),
				note
			});
			return jsonResponse({ pinned: hash, name });
		}
		if (method === 'DELETE' && segments.length === 5) {
			const name = decodeURIComponent(segments[4]);
			const removed = await db.removePin(env.ATTIC_DB, cache.id, name);
			if (!removed) return errorResponse(404, `No pin named "${name}"`);
			return jsonResponse({ unpinned: name });
		}
		return errorResponse(404, 'Not found');
	}

	if (route === 'cache-config' && (segments.length === 4 || segments.length === 5)) {
		const cacheName = segments[3];
		const permission = permissionForCache(token, cacheName);
		try {
			if (method === 'POST' && segments.length === 4) {
				if (!permission.createCache) return errorResponse(403, 'Permission denied: create cache');
				// Clients may send no body, or null.
				const body = (await readJson(request, JSON_LIMITS.cacheConfig, { optional: true })) ?? {};
				const { public_key } = await createCache(
					env,
					cacheName,
					body as import('./cache-config').CreateCacheOptions,
					token.sub
				);
				return jsonResponse({ name: cacheName, created: true, public_key });
			}
			if (method === 'PATCH' && segments.length === 4) {
				// Configure only — a create-anywhere (cc) token must not be able to
				// reconfigure existing caches (it used to be accepted here, which
				// let it rotate any cache's signing keypair).
				if (!permission.configureCache) {
					return errorResponse(403, 'Permission denied: configure cache');
				}
				const body = await readJson(request, JSON_LIMITS.cacheConfig);
				// Trust-affecting fields (keypair, visibility, upstream key hints)
				// are gated inside configureCache; the admin-only nimbus `ct` claim
				// is this route's authority for them. Keypair rotations purge the
				// cache's edge entries in there too.
				const result = await configureCache(
					env,
					cacheName,
					body as import('./cache-config').ConfigureCacheOptions,
					{ trustAuthorized: token.ct, ctx }
				);
				return jsonResponse({ name: cacheName, updated: true, ...result });
			}
			if (method === 'DELETE' && segments.length === 4) {
				if (!permission.destroyCache) return errorResponse(403, 'Permission denied: destroy cache');
				await destroyCache(env, cacheName, ctx);
				return jsonResponse({ name: cacheName, deleted: true });
			}
			if (method === 'POST' && segments[4] === 'rename') {
				// Renaming is a configure on the source and a create on the target.
				// Never create alone: a `cc:*` token could take over any cache.
				if (!permission.configureCache) {
					return errorResponse(403, 'Permission denied: configure cache');
				}
				const body = await readJson(request, JSON_LIMITS.rename);
				const newName = isRecord(body) ? body.new_name : undefined;
				if (typeof newName !== 'string' || !newName) return errorResponse(400, 'Missing new_name');
				if (!permissionForCache(token, newName).createCache) {
					return errorResponse(403, 'Permission denied: create cache (target name)');
				}
				await renameCache(env, cacheName, newName);
				return jsonResponse({ name: newName, renamed_from: cacheName, renamed: true });
			}
		} catch (e) {
			return caughtResponse('cache-config unhandled', request, e);
		}
	}

	return errorResponse(404, 'Not found');
}

/** The stock attic client (User-Agent `Attic/<version> (...)`, sent since
 * 2025). Older attic clients send none and keep nimbus's defaults. */
function isAtticClient(request: Request): boolean {
	return /^attic\//i.test(request.headers.get('User-Agent') ?? '');
}

/** attic's UploadPathResultKind is `Uploaded` / `Deduplicated`; nimbus clients
 * compare the lowercase forms, so only attic gets the capitalized spelling. */
async function atticUploadKind(response: Response): Promise<Response> {
	if (!response.ok) return response;
	const body = (await response.json()) as Record<string, unknown>;
	if (body.kind === 'uploaded') body.kind = 'Uploaded';
	else if (body.kind === 'deduplicated') body.kind = 'Deduplicated';
	return jsonResponse(body, response.status);
}

/** Public base URL for API/substituter endpoints in cache-info responses.
 * CACHE_BASE_URL wins over the request origin: local dev rewrites the Host
 * header to the custom domain, which clients cannot reach. */
function apiBase(env: Env, url: URL): string {
	return (env.CACHE_BASE_URL ?? url.origin).replace(/\/+$/, '');
}

/**
 * Handle a request addressed to the cache API host. Fully native — the
 * binary-cache protocol, the attic v1 API, and CLI auth all run in-process.
 */
export async function handleCacheApi(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
	route?: string
): Promise<Response> {
	return observeRequest(
		request,
		env,
		'gateway',
		async () => {
			try {
				return await handleCacheApiInner(request, env, ctx);
			} catch (e) {
				// Without this boundary an unhandled throw (a D1/R2 hiccup mid-upload, a
				// read-path error crossing the CachedStore RPC) surfaces to Cloudflare as
				// a raw 1101 with no logged stack. caughtResponse logs the stack and
				// returns a controlled 500/503 so client retry paths engage.
				return caughtResponse('cache-api unhandled', request, e);
			}
		},
		route
	);
}

async function handleCacheApiInner(
	request: Request,
	env: Env,
	ctx?: ExecutionContext
): Promise<Response> {
	const url = new URL(request.url);
	const segments = url.pathname.split('/').filter(Boolean);
	const method = request.method;

	if (segments.length === 0) {
		// A person in a browser landed on the cache hostname — send them to the
		// admin UI. Nix and attic clients never send Accept: text/html.
		if (request.headers.get('Accept')?.includes('text/html')) {
			return Response.redirect(env.APP_URL ?? 'https://app.cache.kclj.io', 302);
		}
		return new Response('nimbus is running', { status: 200 });
	}

	// Root proxy: nix-cache-info / narinfo at depth 1, NARs under /nar/. NAR
	// paths may nest deeper than one segment (FlakeHub-style upstreams emit
	// "nar/<hash>/sha256:<hex>.nar" URLs in their narinfos), so everything
	// after /nar/ is the file path.
	if ((method === 'GET' || method === 'HEAD') && segments.length === 1) {
		if (segments[0] === 'nix-cache-info') return handleProxyNixCacheInfo(method === 'HEAD');
		if (segments[0].endsWith('.narinfo')) {
			return handleProxyNarInfo(request, env, ctx, segments[0]);
		}
	}
	if ((method === 'GET' || method === 'HEAD') && segments.length >= 2 && segments[0] === 'nar') {
		return handleProxyNar(request, env, ctx, segments.slice(1).join('/'), method === 'HEAD');
	}

	if (segments[0] === '_api') {
		if (segments[1] === 'v1' && segments.length >= 3) {
			return handleV1(request, env, ctx, url, segments);
		}
		return errorResponse(404, 'Not found');
	}

	if ((method === 'GET' || method === 'HEAD') && segments.length === 2) {
		const [cacheName, rest] = segments;
		if (rest === 'nix-cache-info') {
			return handleNixCacheInfo(request, env, cacheName, method === 'HEAD');
		}
		if (rest === 'attic-cache-info') {
			const limited = await chargeApiBudget(request, env);
			if (limited) return limited;
			return handleCacheInfo(request, env, cacheName, apiBase(env, url));
		}
		if (rest.endsWith('.narinfo')) {
			return handleNarInfo(request, env, ctx, cacheName, rest);
		}
	}

	// Same deep-path allowance as the root /nar/ route, for per-cache
	// passthroughs of FlakeHub-style upstream narinfos.
	if ((method === 'GET' || method === 'HEAD') && segments.length >= 3 && segments[1] === 'nar') {
		return handleNar(
			request,
			env,
			ctx,
			segments[0],
			segments.slice(2).join('/'),
			method === 'HEAD'
		);
	}

	return errorResponse(404, 'Not found');
}
