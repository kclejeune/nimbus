// Request router for the attic binary-cache API, served from the SvelteKit
// worker when the request arrives on the cache hostname. Ported routes are
// handled natively in TypeScript; everything else proxies to the Rust
// attic-worker over the service binding until its port lands.

import * as db from './db';
import { maybeSizeTriggeredGc, runGc } from './gc';
import { filterUpstreamPaths, findExistingPaths, parseUpstreams } from './missing-paths';
import { buildNarInfo } from './narinfo';
import {
	NO_PERMISSION,
	parseBearerToken,
	permissionForCache,
	verifyAtticToken,
	type Permission,
	type VerifiedToken
} from './token';

type Env = App.Platform['env'];
type ExecutionContext = App.Platform['ctx'];

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

/** Proxy an unported route to the Rust attic-worker service binding. */
function proxyToWorker(request: Request, env: Env): Promise<Response> {
	return env.ATTIC_API.fetch(request as never) as unknown as Promise<Response>;
}

async function verifyRequestToken(request: Request, env: Env): Promise<VerifiedToken | null> {
	const bearer = parseBearerToken(request.headers.get('Authorization'));
	if (!bearer) return null;
	if (!env.JWT_HS256_SECRET_BASE64) throw new Error('JWT secret not configured');

	const token = await verifyAtticToken(bearer, env.JWT_HS256_SECRET_BASE64, {
		issuer: env.JWT_BOUND_ISSUER || undefined,
		audiences: env.JWT_BOUND_AUDIENCES?.split(',').filter(Boolean)
	});

	// Admin-issued tokens carry a jti and can be revoked. A failed revocation
	// lookup is logged and ignored, matching the Rust worker (fail-open on the
	// revocation check only — the signature already verified).
	if (token.jti) {
		try {
			if (await db.isTokenRevoked(env.ATTIC_DB, token.jti)) {
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
 * Pull authorization, mirroring the Rust worker: anonymous requests start with
 * no permissions, public caches implicitly grant pull, and invalid tokens are
 * ignored (not fatal) on public caches.
 */
async function authorizePull(
	request: Request,
	env: Env,
	cacheName: string,
	isPublic: boolean
): Promise<Response | null> {
	let permission: Permission;
	try {
		const token = await verifyRequestToken(request, env);
		permission = permissionForCache(token, cacheName);
	} catch (e) {
		if (!isPublic) return errorResponse(401, `Authentication failed: ${e}`);
		permission = { ...NO_PERMISSION };
	}

	if (isPublic) permission.pull = true;
	if (!permission.pull) return errorResponse(403, 'Permission denied: pull');
	return null;
}

async function handleNixCacheInfo(
	request: Request,
	env: Env,
	cacheName: string,
	head: boolean
): Promise<Response> {
	const cache = await db.findCache(env.ATTIC_DB, cacheName);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`);

	const denied = await authorizePull(request, env, cacheName, cache.is_public === 1);
	if (denied) return denied;

	if (head) return new Response(null, { status: 200 });
	return new Response(
		`StoreDir: ${cache.store_dir}\nWantMassQuery: 1\nPriority: ${cache.priority}\n`,
		{
			status: 200,
			headers: { 'Content-Type': 'text/plain' }
		}
	);
}

async function handleNarInfo(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheName: string,
	filename: string,
	head: boolean
): Promise<Response> {
	const storePathHash = filename.slice(0, -'.narinfo'.length);
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	const cache = await db.findCache(env.ATTIC_DB, cacheName);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`);

	const denied = await authorizePull(request, env, cacheName, cache.is_public === 1);
	if (denied) return denied;

	const found = await db.findObject(env.ATTIC_DB, cacheName, storePathHash);
	if (!found) return errorResponse(404, 'Not found');

	if (head) {
		return new Response(null, {
			status: 200,
			headers: { 'Content-Type': 'text/x-nix-narinfo' }
		});
	}

	// LRU bookkeeping, off the response's critical path.
	const touch = db.touchObject(env.ATTIC_DB, cacheName, storePathHash).catch(() => {});
	ctx?.waitUntil(touch);

	const chunks = await db.findChunksForNar(env.ATTIC_DB, found.nar.id);
	const narinfo = await buildNarInfo(found.object, found.nar, chunks[0], cache.keypair);

	return new Response(narinfo, {
		status: 200,
		headers: { 'Content-Type': 'text/x-nix-narinfo' }
	});
}

async function handleNar(
	request: Request,
	env: Env,
	cacheName: string,
	filename: string,
	head: boolean
): Promise<Response> {
	const narHashRaw = filename.split('.')[0];
	if (!narHashRaw) return errorResponse(400, 'Invalid NAR path');

	const cache = await db.findCache(env.ATTIC_DB, cacheName);
	if (!cache) return errorResponse(404, 'Not found');

	const denied = await authorizePull(request, env, cacheName, cache.is_public === 1);
	if (denied) return denied;

	const nar =
		(await db.findNarByHash(env.ATTIC_DB, `sha256:${narHashRaw}`)) ??
		(await db.findNarByHash(env.ATTIC_DB, narHashRaw));
	if (!nar) return errorResponse(404, 'Not found');

	const chunks = await db.findChunksForNar(env.ATTIC_DB, nar.id);
	if (chunks.length === 0) return errorResponse(500, 'NAR has no chunks');
	if (chunks.length > 1) return errorResponse(501, 'Multi-chunk NARs not yet supported');

	const chunk = chunks[0];
	let key: string | undefined;
	try {
		key = JSON.parse(chunk.remote_file).key;
	} catch {
		// fall through to the error below
	}
	if (!key) return errorResponse(500, 'No key in remote file');

	if (head) {
		const headers = new Headers({ 'Content-Type': 'application/x-nix-nar' });
		if (chunk.file_size != null) headers.set('Content-Length', String(chunk.file_size));
		return new Response(null, { status: 200, headers });
	}

	const object = await env.CACHE_BUCKET.get(key);
	if (!object) return errorResponse(404, `File not found in storage: ${key}`);

	return new Response(object.body as unknown as BodyInit, {
		status: 200,
		headers: {
			'Content-Type': 'application/x-nix-nar',
			'Content-Length': String(object.size)
		}
	});
}

/**
 * POST /_api/v1/get-missing-paths — which of the client's closure hashes need
 * uploading. Requires push permission. Paths present in the cache's configured
 * upstreams (e.g. cache.nixos.org) are excluded so clients never push them.
 */
async function handleGetMissingPaths(request: Request, env: Env): Promise<Response> {
	let token: VerifiedToken | null;
	try {
		token = await verifyRequestToken(request, env);
	} catch (e) {
		return errorResponse(401, `Authentication failed: ${e}`);
	}
	if (!token) return errorResponse(401, 'No token provided');

	let body: { cache?: string; store_path_hashes?: string[] };
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
	if (!cache) return errorResponse(404, `Cache not found: ${body.cache}`);

	const hashes = body.store_path_hashes.filter((h) => typeof h === 'string' && h.length === 32);
	const existing = await findExistingPaths(env.ATTIC_DB, body.cache, hashes);
	const missing = hashes.filter((h) => !existing.has(h));

	const upstreams = parseUpstreams(cache.upstream_caches);
	const missingPaths =
		upstreams.length > 0 && missing.length > 0
			? await filterUpstreamPaths(env.ATTIC_DB, upstreams, missing)
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
async function handleGcTrigger(request: Request, env: Env, url: URL): Promise<Response> {
	let token: VerifiedToken | null;
	try {
		token = await verifyRequestToken(request, env);
	} catch (e) {
		return errorResponse(401, `Authentication failed: ${e}`);
	}
	if (!token) return errorResponse(401, 'No token provided');
	if (!permissionForCache(token, 'gc').delete) {
		return errorResponse(403, 'Permission denied: delete');
	}

	const dryRun = url.searchParams.get('dry_run') === '1';
	const stats = await runGc(env, { dryRun });
	return new Response(JSON.stringify(dryRun ? { ...stats, dry_run: 1 } : stats), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Handle a request addressed to the cache API host. Returns a Response for
 * every request — natively for ported routes, via the service-binding proxy
 * for the rest (v1 API, uploads).
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
		return new Response('Attic Worker is running', { status: 200 });
	}

	if (segments[0] === '_api') {
		if (method === 'POST' && segments[1] === 'v1' && segments.length === 3) {
			if (segments[2] === 'get-missing-paths') return handleGetMissingPaths(request, env);
			if (segments[2] === 'gc') return handleGcTrigger(request, env, url);
		}
		// The rest of the v1 API (uploads, cache config, CLI auth) is not ported yet.
		const response = await proxyToWorker(request, env);

		// Uploads grow storage: after one lands, check size budgets out-of-band
		// (debounced in maybeSizeTriggeredGc) instead of waiting for the cron.
		const isUpload =
			segments[1] === 'v1' &&
			segments[2] === 'upload-path' &&
			(segments.length === 3 || segments[3] === 'complete');
		if (ctx && isUpload && response.ok) {
			ctx.waitUntil(maybeSizeTriggeredGc(env));
		}
		return response;
	}

	if ((method === 'GET' || method === 'HEAD') && segments.length === 2) {
		const [cacheName, rest] = segments;
		if (rest === 'nix-cache-info') {
			return handleNixCacheInfo(request, env, cacheName, method === 'HEAD');
		}
		if (rest.endsWith('.narinfo')) {
			return handleNarInfo(request, env, ctx, cacheName, rest, method === 'HEAD');
		}
	}

	if ((method === 'GET' || method === 'HEAD') && segments.length === 3 && segments[1] === 'nar') {
		return handleNar(request, env, segments[0], segments[2], method === 'HEAD');
	}

	return proxyToWorker(request, env);
}
