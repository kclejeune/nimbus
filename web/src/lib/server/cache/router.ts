// Request router for the attic binary-cache API, dispatched from
// worker-entry.ts when a request arrives on the cache hostname. Fully native
// TypeScript — the legacy Rust worker is no longer involved.

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
import * as db from './db';
import { listPins, runGc } from './gc';
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
	upstreamsForCache
} from './missing-paths';
import { type ExecutionContext } from './platform';
import {
	getProxyKeypair,
	isKnownAbsent,
	pickReadableWinner,
	recordAbsent,
	shouldTouch
} from './proxy';
import { TtlMemo } from './ttl-memo';
import { persistUpstreamPath } from './pullthrough';
import { handleCacheList, handleDestroyPath, handleTokensApi } from './v1-admin';
import { edgeEvent, recordRead, UNIFIED_LABEL, type EdgeEvent } from './metrics';
import { extractPublicKey } from '../attic/signing';
import {
	keyedNarinfoUrl,
	PERSIST_CACHE_HEADER,
	PERSIST_UPSTREAM_HEADER,
	PREFETCH_MARKER_HEADER,
	serveStore,
	UPSTREAM_MARKER_HEADER
} from './store';
import {
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
	handleUploadPath,
	type CdcManifest
} from './upload';

type Env = App.Platform['env'];

// Per-isolate memo of the token-revocation verdict, keyed by jti. Every
// authenticated request (a CI fleet reuses one token for hundreds of
// pulls/sec) otherwise runs isTokenDisabled against D1; without this memo that
// query also hit the write primary. The read now goes to a replica AND is
// cached here for a short TTL, collapsing a burst of same-token requests to
// one lookup per window. The TTL bounds how long a just-revoked or
// just-suspended token keeps working (both fail-safe: re-enabling is likewise
// delayed at most one TTL); these attic JWTs are already short-lived, so the
// window is small next to their lifetime. Only successful reads are memoized —
// a thrown D1 error falls through to the caller's fail-open path uncached.
const REVOCATION_TTL_MS = 30_000;
const REVOCATION_MEMO_MAX_ENTRIES = 10_000;
const revocationMemo = new TtlMemo<boolean>(REVOCATION_TTL_MS, REVOCATION_MEMO_MAX_ENTRIES);

async function isJtiDisabled(env: Env, jti: string): Promise<boolean> {
	const cached = revocationMemo.get(jti);
	if (cached !== undefined) return cached;
	const disabled = await db.isTokenDisabled(db.readSession(env.ATTIC_DB), jti);
	revocationMemo.set(jti, disabled);
	return disabled;
}

async function verifyRequestToken(request: Request, env: Env): Promise<VerifiedToken | null> {
	const bearer = parseAuthToken(request.headers.get('Authorization'));
	if (!bearer) return null;
	if (!env.JWT_HS256_SECRET_BASE64 && !env.JWT_RS256_PUBKEY_BASE64) {
		throw new Error('JWT secret not configured');
	}

	const token = await verifyAtticToken(
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

	// Admin-issued tokens carry a jti and can be revoked, or suspended while
	// the owner's account is deactivated. A failed lookup is logged and
	// ignored, matching the Rust worker (fail-open on the revocation check
	// only — the signature already verified).
	if (token.jti) {
		try {
			if (await isJtiDisabled(env, token.jti)) {
				throw new Error('Token has been revoked');
			}
		} catch (e) {
			if (e instanceof Error && e.message === 'Token has been revoked') throw e;
			console.warn(`revocation check failed for jti ${token.jti}: ${e}`);
		}
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
	const cache = await findCacheCached(env.ATTIC_DB, cacheName);
	if (!cache) {
		if (hasDiscovery) {
			return { response: errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache') };
		}
		return { response: errorResponse(401, 'Unauthorized') };
	}
	if (cache.is_public === 1) return { cache };
	if (authError) return { response: errorResponse(401, `Authentication failed: ${authError}`) };
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
	const forwarded = new Request(request);
	forwarded.headers.delete('Authorization');
	// Internal prefetch-loopback marker (store.ts); client-supplied, it would
	// falsely mark the request as a prefetch and disable its upstream fallback.
	forwarded.headers.delete(PREFETCH_MARKER_HEADER);
	const store = ctx?.exports?.CachedStore;
	if (!store && !warnedStoreUnavailable) {
		warnedStoreUnavailable = true;
		console.warn('ctx.exports.CachedStore unavailable; serving read path uncached');
	}
	const response = store ? await store.fetch(forwarded) : await serveStore(forwarded, env, ctx);

	const cacheName = response.headers.get(PERSIST_CACHE_HEADER);
	const upstreamUrl = response.headers.get(PERSIST_UPSTREAM_HEADER);
	if (!cacheName || !upstreamUrl || response.status !== 200) return response;
	// The narinfo body is tiny, so buffering it to hand to the ingest is free.
	const text = await response.text();
	if (ctx?.waitUntil) {
		const origin = new URL(request.url).origin;
		ctx.waitUntil(persistUpstreamPath(env, ctx, origin, cacheName, upstreamUrl, text));
	}
	const stripped = new Response(text, response);
	stripped.headers.delete(PERSIST_CACHE_HEADER);
	stripped.headers.delete(PERSIST_UPSTREAM_HEADER);
	return stripped;
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

	// NARs are content-addressed, so the store request drops the cache name:
	// every cache referencing a NAR shares one edge entry, and a miss reads R2
	// once instead of once per cache. The query string is dropped too — no
	// legit NAR URL carries one, and forwarding it would let a client mint
	// unlimited distinct edge keys for the same NAR (each a full D1+R2 miss).
	// Cache-specific concerns stay here: the visibility header is stamped per
	// request, and a store miss falls back to the cache's upstreams
	// (passthrough narinfo NAR URLs resolve that way).
	const shared = new URL(request.url);
	shared.pathname = `/_nar/${filename}`;
	shared.search = '';
	const response = await forwardToStore(new Request(shared, request), env, ctx);

	if (response.status === 404) {
		const upstreamUrl = await upstreamNarRedirect(
			env,
			ctx,
			auth.cache,
			filename,
			request.headers.get('CF-Connecting-IP')
		);
		recordRead(env, 'nar', cacheName, {
			status: 404,
			viaUpstream: !!upstreamUrl,
			edge: storeEdge(response)
		});
		if (upstreamUrl) return Response.redirect(upstreamUrl, 302);
		return response;
	}

	// Retention is download-driven (like the reference server): touch every
	// object in this cache backed by the NAR, off the critical path. This must
	// happen in the gateway — downloads served from the edge cache never reach
	// the CachedStore entrypoint — and only after the store confirmed the NAR
	// exists: touching before the read gave nonexistent-hash floods a free
	// primary write per request, while real NARs stay coalesced by shouldTouch.
	if (!head && response.ok && shouldTouch(cacheName, narHashRaw)) {
		const touch = db.touchObjectsForNarHash(env.ATTIC_DB, cacheName, narHashRaw).catch(() => {});
		ctx?.waitUntil(touch);
	}
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

	const token = await proxyToken(request, env);
	const session = db.readSession(env.ATTIC_DB);
	const candidates = await db.cachesWithStorePathHash(session, storePathHash);
	const winner = pickReadableWinner(token, candidates);
	// No local winner (not stored anywhere, or stored only in caches this
	// requester can't read): fall back to the union of live caches' upstreams.
	// Upstream content is public, so serving it regardless of token leaks
	// nothing; not-found and not-readable both end as 404 — the root names no
	// caches, so there is nothing to enumerate.
	if (!winner) {
		const fallback = new URL(
			`${new URL(request.url).origin}/_proxy_upstream/${storePathHash}.narinfo`
		);
		const response = await forwardToStore(new Request(fallback, request), env, ctx);
		// The absent memo is token-independent, so only an empty candidate set
		// (nothing local for anyone) plus an upstream miss may record it.
		if (response.status === 404) {
			if (candidates.length === 0) recordAbsent(storePathHash);
			recordRead(env, 'narinfo', UNIFIED_LABEL, { status: 404, edge: storeEdge(response) });
			return errorResponse(404, 'Not found', 'NoSuchObject');
		}
		// A 200 here is upstream content served through the union fallback.
		recordRead(env, 'narinfo', UNIFIED_LABEL, {
			status: response.status,
			viaUpstream: true,
			edge: storeEdge(response)
		});
		return withCachePolicy(stripUpstreamMarker(response), true);
	}

	const keyed = new URL(
		`${new URL(request.url).origin}/_proxy/${winner.name}/${storePathHash}.narinfo`
	);
	try {
		keyed.searchParams.set('pk', extractPublicKey(await getProxyKeypair(env)));
	} catch {
		// keypair unavailable: serve unsigned/stored-sig variant unkeyed
	}
	const response = await forwardToStore(new Request(keyed, request), env, ctx);
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

	const token = await proxyToken(request, env);
	const session = db.readSession(env.ATTIC_DB);
	const winner = pickReadableWinner(
		token,
		await db.cachesWithNarHash(session, [`sha256:${narHashRaw}`, narHashRaw])
	);
	// NAR URLs served by root-proxy upstream passthrough narinfos resolve here
	// with no local winner, so the root needs the same upstream redirect as the
	// per-cache route — against the union of live caches' upstreams.
	const upstreamRedirect = async (): Promise<Response | null> => {
		const url = await upstreamNarRedirect(
			env,
			ctx,
			null,
			filename,
			request.headers.get('CF-Connecting-IP')
		);
		return url ? Response.redirect(url, 302) : null;
	};
	if (!winner) {
		const redirect = await upstreamRedirect();
		recordRead(env, 'nar', UNIFIED_LABEL, { status: 404, viaUpstream: !!redirect, edge: 'none' });
		return redirect ?? errorResponse(404, 'Not found', 'NoSuchObject');
	}

	// Download-driven retention, attributed to the winning cache (see handleNar).
	if (!head && shouldTouch(winner.name, narHashRaw)) {
		const touch = db.touchObjectsForNarHash(env.ATTIC_DB, winner.name, narHashRaw).catch(() => {});
		ctx?.waitUntil(touch);
	}

	// Same shared content-addressed edge entry as the per-cache route, with the
	// same query-string drop (see handleNar).
	const shared = new URL(request.url);
	shared.pathname = `/_nar/${filename}`;
	shared.search = '';
	const response = await forwardToStore(new Request(shared, request), env, ctx);
	if (response.status === 404) {
		// Deletion race (GC reaped the NAR between resolution and read): the
		// upstreams may still have it, same as the per-cache route.
		const redirect = await upstreamRedirect();
		recordRead(env, 'nar', UNIFIED_LABEL, {
			status: 404,
			viaUpstream: !!redirect,
			edge: storeEdge(response)
		});
		return redirect ?? response;
	}
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
async function handleGetMissingPaths(request: Request, env: Env): Promise<Response> {
	let token: VerifiedToken | null;
	try {
		token = await verifyRequestToken(request, env);
	} catch (e) {
		return errorResponse(401, `Authentication failed: ${e}`);
	}
	if (!token) return errorResponse(401, 'No token provided');

	let body: {
		cache?: string;
		store_path_hashes?: string[];
		ignore_upstream_cache_filter?: boolean;
	};
	try {
		body = await request.json();
	} catch (e) {
		return errorResponse(400, `Invalid JSON: ${e}`);
	}
	if (!body.cache || !Array.isArray(body.store_path_hashes)) {
		return errorResponse(400, 'Missing cache or store_path_hashes');
	}
	if (!permissionForCache(token, body.cache).push) {
		return errorResponse(403, 'Permission denied: push');
	}

	// Replica reads throughout: staleness at worst re-reports a just-pushed
	// path as missing, and the upload path dedups the re-push. Keeps this
	// run-start read burst (nix-fast-build checks every path up front) off the
	// write primary, which is where the push writes contend.
	const session = db.readSession(env.ATTIC_DB);
	const cache = await db.findCache(session, body.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${body.cache}`, 'NoSuchCache');

	const hashes = body.store_path_hashes.filter((h) => typeof h === 'string' && h.length === 32);
	const existing = await findExistingPaths(session, body.cache, hashes);
	const missing = hashes.filter((h) => !existing.has(h));

	const upstreams = body.ignore_upstream_cache_filter
		? []
		: await upstreamsForCache(session, cache);
	const missingPaths =
		upstreams.length > 0 && missing.length > 0
			? await filterUpstreamPaths(session, upstreams, missing)
			: missing;

	return new Response(JSON.stringify({ missing_paths: missingPaths }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * POST /_api/v1/gc — manual GC trigger. Mirrors the Rust worker's auth: delete
 * permission on a probe cache named "gc" (in practice a wildcard-scoped
 * token). `?dry_run=1` reports what retention would delete without deleting.
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
		return errorResponse(401, `Authentication failed: ${e}`);
	}
	if (!token) return errorResponse(401, 'No token provided');
	// The nimbus gc claim is minted admin-only from the tokens page (it is
	// storage-wide, so it is never a per-cache grant); the wildcard-delete
	// probe keeps attic-native tokens working.
	if (!token.gc && !permissionForCache(token, 'gc').delete) {
		return errorResponse(403, 'Permission denied: garbage collection');
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
	try {
		return withVisibility(
			jsonResponse(await cacheInfo(env, cacheName, baseUrl)),
			auth.cache.is_public === 1
		);
	} catch (e) {
		const { status, message, kind } = statusOf(e);
		return errorResponse(status, message, kind);
	}
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
		return { response: errorResponse(401, `Authentication failed: ${e}`) };
	}
}

function statusOf(e: unknown): { status: number; message: string; kind?: string } {
	if (e instanceof CacheConfigError) {
		return {
			status: e.status,
			message: e.message,
			kind: e.status === 404 ? 'NoSuchCache' : undefined
		};
	}
	return { status: 500, message: `${e}` };
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

	// Unauthenticated discovery endpoints.
	if (method === 'GET' && route === 'auth-config' && segments.length === 3) {
		return handleAuthConfig(env);
	}
	if (method === 'POST' && route === 'cli' && segments.length === 4) {
		// These are the only unauthenticated endpoints that touch the D1
		// primary (device start INSERTs a row; token polls read one), so they
		// get a best-effort backstop before any work. Keyed per client IP and
		// endpoint — there is no authenticated identity here, and per-IP keeps
		// one client from consuming everyone else's budget. The limit is a
		// runaway backstop, not traffic shaping: ~25x one login flow's polling
		// rate (~12/min), so even a shared/CGNAT IP with many simultaneous
		// logins never trips it. User-facing, so a limiter error fails open
		// (contrast the prefetch budget, which fails closed).
		if (env.DEVICE_AUTH_LIMITER) {
			const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
			const { success } = await env.DEVICE_AUTH_LIMITER.limit({
				key: `device:${segments[3]}:${ip}`
			}).catch(() => ({ success: true }));
			if (!success) return errorResponse(429, 'Too many requests; retry shortly');
		}
		if (segments[3] === 'device') return handleDeviceStart(env);
		if (segments[3] === 'token') {
			const body = await (request.json() as Promise<{ device_code?: string }>).catch(() => null);
			if (!body?.device_code) return errorResponse(400, 'Missing device_code');
			return handleDeviceToken(env, body.device_code);
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
		return handleCacheList(env, token);
	}

	if (method === 'POST' && route === 'get-missing-paths' && segments.length === 3) {
		return handleGetMissingPaths(request, env);
	}
	if (method === 'POST' && route === 'gc' && segments.length === 3) {
		return handleGcTrigger(request, env, ctx, url);
	}

	// Everything below requires a token.
	const auth = await requireToken(request, env);
	if ('response' in auth) return auth.response;
	const token = auth.token;
	const canPush = (cacheName: string) => permissionForCache(token, cacheName).push;

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
		// The CDC endpoints are stateless, so authorization rides along on each
		// request: the manifest body carries the cache for POSTs, and chunk PUTs
		// carry it as a query param. Provenance is stamped server-side —
		// client-supplied source/created_by fields are overwritten.
		const parseManifest = async (): Promise<CdcManifest | Response> => {
			const body = await (request.json() as Promise<CdcManifest>).catch(() => null);
			if (!body?.nar_info?.cache || typeof body.nar_size !== 'number') {
				return errorResponse(400, 'Invalid request body');
			}
			if (!canPush(body.nar_info.cache)) return errorResponse(403, 'Permission denied: push');
			body.nar_info.source = 'push';
			body.nar_info.created_by = token.sub ?? null;
			return body;
		};

		let response: Response;
		if (method === 'PUT' && segments.length === 3) {
			response = await handleUploadPath(request, env, ctx, canPush, token.sub ?? null);
		} else if (method === 'POST' && segments[3] === 'chunks' && segments.length === 4) {
			const manifest = await parseManifest();
			if (manifest instanceof Response) return manifest;
			response = await handleCdcQuery(env, ctx, url.origin, manifest);
		} else if (method === 'PUT' && segments[3] === 'chunks' && segments.length === 5) {
			const cacheName = url.searchParams.get('cache');
			if (!cacheName) return errorResponse(400, 'Missing cache parameter');
			if (!canPush(cacheName)) return errorResponse(403, 'Permission denied: push');
			response = await handleCdcChunkPut(request, env, segments[4]);
		} else if (
			method === 'POST' &&
			segments[3] === 'chunks' &&
			segments[4] === 'complete' &&
			segments.length === 5
		) {
			const manifest = await parseManifest();
			if (manifest instanceof Response) return manifest;
			response = await handleCdcComplete(env, ctx, url.origin, manifest);
		} else {
			return errorResponse(404, 'Not found');
		}

		// Size-budget enforcement runs on the nightly GC cron (scheduled →
		// runGc), not inline here: the budget check (a SUM over chunk) plus a
		// possible full GC hit the D1 write primary, and firing that from every
		// upload starved concurrent pushes' writes — tipping the primary's queue
		// into "D1 requests queued for too long". The tradeoff is that a size
		// budget can be exceeded for up to a day between cron runs.
		return response;
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
			const body = await (
				request.json() as Promise<{ store_path_hash?: string; note?: string }>
			).catch(() => null);
			const hash = body?.store_path_hash ?? '';
			if (!/^[0-9a-z]{32}$/.test(hash)) return errorResponse(400, 'Invalid store path hash');
			await db.addGcRoot(env.ATTIC_DB, cache.id, hash, body?.note ?? null);
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
			const body = await (
				request.json() as Promise<{
					name?: string;
					store_path_hash?: string;
					keep_revisions?: number;
					keep_days?: number;
					note?: string;
				}>
			).catch(() => null);
			const name = (body?.name ?? '').trim();
			const hash = body?.store_path_hash ?? '';
			if (!db.PIN_NAME_RE.test(name)) {
				return errorResponse(400, 'Invalid pin name (1-100 chars, no whitespace)');
			}
			if (!db.STORE_PATH_HASH_RE.test(hash)) return errorResponse(400, 'Invalid store path hash');
			const keep = (v: unknown) =>
				typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
			await db.upsertPin(env.ATTIC_DB, cache.id, name, hash, {
				keepRevisions: keep(body?.keep_revisions),
				keepDays: keep(body?.keep_days),
				note: body?.note ?? null
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
				const body = await (request.json() as Promise<Record<string, unknown>>).catch(() => ({}));
				const { public_key } = await createCache(
					env,
					cacheName,
					(body ?? {}) as import('./cache-config').CreateCacheOptions,
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
				const body = await (request.json() as Promise<Record<string, unknown>>).catch(() => null);
				if (!body) return errorResponse(400, 'Invalid JSON');
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
				const body = await (request.json() as Promise<{ new_name?: string }>).catch(() => null);
				if (!body?.new_name) return errorResponse(400, 'Missing new_name');
				// Renaming is a configure on the source and a create on the target.
				if (!permission.configureCache && !permission.createCache) {
					return errorResponse(403, 'Permission denied: requires configure or create cache');
				}
				if (!permissionForCache(token, body.new_name).createCache) {
					return errorResponse(403, 'Permission denied for target name');
				}
				await renameCache(env, cacheName, body.new_name);
				return jsonResponse({ name: body.new_name, renamed_from: cacheName, renamed: true });
			}
		} catch (e) {
			const { status, message, kind } = statusOf(e);
			return errorResponse(status, message, kind);
		}
	}

	return errorResponse(404, 'Not found');
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
	ctx?: ExecutionContext
): Promise<Response> {
	try {
		return await handleCacheApiInner(request, env, ctx);
	} catch (e) {
		// Without this boundary an unhandled throw (a D1/R2 hiccup mid-upload, a
		// read-path error crossing the CachedStore RPC) surfaces to Cloudflare as
		// a raw 1101 with no logged stack. Log it — observability is on — and
		// return a controlled 500 so nix's retry path engages and the stack is
		// visible in Workers Logs.
		logUnhandled('cache-api unhandled', request, e);
		const { status, message, kind } = statusOf(e);
		return errorResponse(status, message, kind);
	}
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
