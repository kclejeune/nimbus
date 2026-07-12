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
import { handleAuthConfig, handleDeviceStart, handleDeviceToken } from './cli-auth';
import * as db from './db';
import { maybeSizeTriggeredGc, runGc } from './gc';
import { errorResponse, jsonResponse, withCachePolicy, withVisibility } from '../attic/http';
import {
	filterUpstreamPaths,
	findExistingPaths,
	findUpstreamNar,
	parseUpstreams
} from './missing-paths';
import { type ExecutionContext } from './platform';
import { getProxyKeypair, isKnownAbsent, pickReadableWinner, recordAbsent } from './proxy';
import { extractPublicKey } from '../attic/signing';
import { cacheTag, keyedNarinfoUrl, PREFETCH_DEPTH_HEADER, serveStore } from './store';
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
			if (await db.isTokenDisabled(env.ATTIC_DB, token.jti)) {
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

	// Replica read: a cache-config change (e.g. visibility flip) taking effect
	// with sub-second replica lag is acceptable for read authorization.
	const cache = await db.findCache(db.readSession(env.ATTIC_DB), cacheName);
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
 */
let warnedStoreUnavailable = false;

function forwardToStore(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined
): Promise<Response> {
	const forwarded = new Request(request);
	forwarded.headers.delete('Authorization');
	// Internal recursion control for reference prefetch; a client-supplied
	// value would inflate the loopback fan-out.
	forwarded.headers.delete(PREFETCH_DEPTH_HEADER);
	const store = ctx?.exports?.CachedStore;
	if (!store) {
		if (!warnedStoreUnavailable) {
			warnedStoreUnavailable = true;
			console.warn('ctx.exports.CachedStore unavailable; serving read path uncached');
		}
		return serveStore(forwarded, env, ctx);
	}
	return store.fetch(forwarded);
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
	return withCachePolicy(response, auth.cache.is_public === 1);
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

	// Retention is download-driven (like the reference server): touch every
	// object in this cache backed by the NAR, off the critical path. This must
	// happen in the gateway — downloads served from the edge cache never reach
	// the CachedStore entrypoint.
	if (!head) {
		const touch = db.touchObjectsForNarHash(env.ATTIC_DB, cacheName, narHashRaw).catch(() => {});
		ctx?.waitUntil(touch);
	}

	// NARs are content-addressed, so the store request drops the cache name:
	// every cache referencing a NAR shares one edge entry, and a miss reads R2
	// once instead of once per cache. Cache-specific concerns stay here: the
	// visibility header is stamped per request, and a store miss falls back to
	// the cache's upstreams (passthrough narinfo NAR URLs resolve that way).
	const shared = new URL(request.url);
	shared.pathname = `/_nar/${filename}`;
	const response = await forwardToStore(new Request(shared, request), env, ctx);

	if (response.status === 404) {
		const upstreamUrl = await findUpstreamNar(
			env.ATTIC_DB,
			parseUpstreams(auth.cache.upstream_caches),
			`nar/${filename}`
		);
		if (upstreamUrl) return Response.redirect(upstreamUrl, 302);
		return response;
	}
	return withCachePolicy(
		withVisibility(new Response(response.body, response), auth.cache.is_public === 1),
		auth.cache.is_public === 1
	);
}

// --- root proxy (read-only): resolve across the requester's readable caches --

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
	if (isKnownAbsent(storePathHash)) return errorResponse(404, 'Not found', 'NoSuchObject');

	const token = await proxyToken(request, env);
	const session = db.readSession(env.ATTIC_DB);
	const candidates = await db.cachesWithStorePathHash(session, storePathHash);
	if (candidates.length === 0) recordAbsent(storePathHash);
	const winner = pickReadableWinner(token, candidates);
	// Not-found and not-readable are both 404: the root names no caches, so
	// there is nothing to enumerate.
	if (!winner) return errorResponse(404, 'Not found', 'NoSuchObject');

	const keyed = new URL(
		`${new URL(request.url).origin}/_proxy/${winner.name}/${storePathHash}.narinfo`
	);
	try {
		keyed.searchParams.set('pk', extractPublicKey(await getProxyKeypair(env)));
	} catch {
		// keypair unavailable: serve unsigned/stored-sig variant unkeyed
	}
	const response = await forwardToStore(new Request(keyed, request), env, ctx);
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
	if (!winner) return errorResponse(404, 'Not found', 'NoSuchObject');

	// Download-driven retention, attributed to the winning cache (see handleNar).
	if (!head) {
		const touch = db.touchObjectsForNarHash(env.ATTIC_DB, winner.name, narHashRaw).catch(() => {});
		ctx?.waitUntil(touch);
	}

	// Same shared content-addressed edge entry as the per-cache route. No
	// upstream fallback at the root: only locally-stored objects resolve.
	const shared = new URL(request.url);
	shared.pathname = `/_nar/${filename}`;
	const response = await forwardToStore(new Request(shared, request), env, ctx);
	if (response.status === 404) return response;
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

	const cache = await db.findCache(env.ATTIC_DB, body.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${body.cache}`, 'NoSuchCache');

	const hashes = body.store_path_hashes.filter((h) => typeof h === 'string' && h.length === 32);
	// Replica reads: staleness at worst re-reports a just-pushed path as
	// missing, and the upload path dedups the re-push.
	const session = db.readSession(env.ATTIC_DB);
	const existing = await findExistingPaths(session, body.cache, hashes);
	const missing = hashes.filter((h) => !existing.has(h));

	const upstreams = body.ignore_upstream_cache_filter ? [] : parseUpstreams(cache.upstream_caches);
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

	if (route === 'upload-path') {
		// The CDC endpoints are stateless, so authorization rides along on each
		// request: the manifest body carries the cache for POSTs, and chunk PUTs
		// carry it as a query param.
		const parseManifest = async (): Promise<CdcManifest | Response> => {
			const body = await (request.json() as Promise<CdcManifest>).catch(() => null);
			if (!body?.nar_info?.cache || typeof body.nar_size !== 'number') {
				return errorResponse(400, 'Invalid request body');
			}
			if (!canPush(body.nar_info.cache)) return errorResponse(403, 'Permission denied: push');
			return body;
		};

		let response: Response;
		if (method === 'PUT' && segments.length === 3) {
			response = await handleUploadPath(request, env, ctx, canPush);
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

		// Uploads grow storage: after one lands, check size budgets out-of-band
		// (debounced in maybeSizeTriggeredGc) instead of waiting for the cron.
		if (ctx && response.ok) ctx.waitUntil(maybeSizeTriggeredGc(env, ctx));
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
				if (!permission.configureCache && !permission.createCache) {
					return errorResponse(403, 'Permission denied: requires configure or create cache');
				}
				const body = await (request.json() as Promise<Record<string, unknown>>).catch(() => null);
				if (!body) return errorResponse(400, 'Invalid JSON');
				// The reference gates retention behind its own permission bit (cq);
				// configure (cr) is accepted too so existing tokens keep working.
				if (
					('retention_period' in body || 'retention_max_bytes' in body) &&
					!permission.configureCacheRetention &&
					!permission.configureCache
				) {
					return errorResponse(403, 'Permission denied: configure cache retention');
				}
				const result = await configureCache(
					env,
					cacheName,
					body as import('./cache-config').ConfigureCacheOptions
				);
				// A rotated keypair re-signs every narinfo; evict the cache's cached
				// copies so clients don't fail signature verification until they
				// expire. Best-effort, like the GC purge.
				if (result.public_key && ctx?.exports?.CachedStore) {
					await ctx.exports.CachedStore.purgeTags([cacheTag(cacheName)]).catch((e) =>
						console.warn(`cache-config: narinfo purge after keypair change failed: ${e}`)
					);
				}
				return jsonResponse({ name: cacheName, updated: true, ...result });
			}
			if (method === 'DELETE' && segments.length === 4) {
				if (!permission.destroyCache) return errorResponse(403, 'Permission denied: destroy cache');
				await destroyCache(env, cacheName);
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

	// Root proxy: nix-cache-info / narinfo at depth 1, NARs under /nar/.
	if ((method === 'GET' || method === 'HEAD') && segments.length === 1) {
		if (segments[0] === 'nix-cache-info') return handleProxyNixCacheInfo(method === 'HEAD');
		if (segments[0].endsWith('.narinfo')) {
			return handleProxyNarInfo(request, env, ctx, segments[0]);
		}
	}
	if ((method === 'GET' || method === 'HEAD') && segments.length === 2 && segments[0] === 'nar') {
		return handleProxyNar(request, env, ctx, segments[1], method === 'HEAD');
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

	if ((method === 'GET' || method === 'HEAD') && segments.length === 3 && segments[1] === 'nar') {
		return handleNar(request, env, ctx, segments[0], segments[2], method === 'HEAD');
	}

	return errorResponse(404, 'Not found');
}
