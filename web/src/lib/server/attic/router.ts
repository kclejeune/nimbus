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
import { errorResponse, jsonResponse, withVisibility } from './http';
import { filterUpstreamPaths, findExistingPaths, parseUpstreams } from './missing-paths';
import { buildNarInfo } from './narinfo';
import {
	NO_PERMISSION,
	parseAuthToken,
	permissionForCache,
	verifyAtticToken,
	type Permission,
	type VerifiedToken
} from './token';
import {
	handleCompleteChunked,
	handleStartChunked,
	handleUploadChunk,
	handleUploadPath
} from './upload';

type Env = App.Platform['env'];
type ExecutionContext = App.Platform['ctx'];

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

	const cache = await db.findCache(env.ATTIC_DB, cacheName);
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

	const auth = await authorizeCacheRead(request, env, cacheName);
	if ('response' in auth) return auth.response;
	const cache = auth.cache;
	const isPublic = cache.is_public === 1;

	const found = await db.findObject(env.ATTIC_DB, cacheName, storePathHash);
	if (!found) return errorResponse(404, 'Not found', 'NoSuchObject');

	if (head) {
		return withVisibility(
			new Response(null, {
				status: 200,
				headers: { 'Content-Type': 'text/x-nix-narinfo' }
			}),
			isPublic
		);
	}

	const chunks = await db.findChunksForNar(env.ATTIC_DB, found.nar.id);
	const narinfo = await buildNarInfo(found.object, found.nar, chunks, cache.keypair);

	return withVisibility(
		new Response(narinfo, {
			status: 200,
			headers: { 'Content-Type': 'text/x-nix-narinfo' }
		}),
		isPublic
	);
}

function chunkKey(chunk: db.ChunkRow): string | null {
	try {
		return JSON.parse(chunk.remote_file).key ?? null;
	} catch {
		return null;
	}
}

/** Parse a single-range `Range: bytes=...` header against a known size. */
function parseRange(
	header: string,
	size: number
): { offset: number; length: number } | 'unsatisfiable' {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === '' && m[2] === '')) return 'unsatisfiable';
	if (m[1] === '') {
		// suffix range: last N bytes
		const suffix = Math.min(Number(m[2]), size);
		if (suffix === 0) return 'unsatisfiable';
		return { offset: size - suffix, length: suffix };
	}
	const start = Number(m[1]);
	if (start >= size) return 'unsatisfiable';
	const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (end < start) return 'unsatisfiable';
	return { offset: start, length: end - start + 1 };
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
	const isPublic = auth.cache.is_public === 1;

	const nar =
		(await db.findNarByHash(env.ATTIC_DB, `sha256:${narHashRaw}`)) ??
		(await db.findNarByHash(env.ATTIC_DB, narHashRaw));
	if (!nar) return errorResponse(404, 'Not found', 'NoSuchObject');

	const chunks = await db.findChunksForNar(env.ATTIC_DB, nar.id);
	if (chunks.length === 0) return errorResponse(500, 'NAR has no chunks');
	if (chunks.length < nar.num_chunks) {
		return errorResponse(503, 'Some chunks of this NAR are missing', 'IncompleteNar');
	}

	const keys: string[] = [];
	for (const chunk of chunks) {
		const key = chunkKey(chunk);
		if (!key) return errorResponse(500, 'No key in remote file');
		keys.push(key);
	}

	// Retention is download-driven (like the reference server): touch every
	// object in this cache backed by the NAR, off the critical path.
	if (!head) {
		const touch = db.touchObjectsForNar(env.ATTIC_DB, cacheName, nar.id).catch(() => {});
		ctx?.waitUntil(touch);
	}

	const totalSize = chunks.every((c) => c.file_size != null)
		? chunks.reduce((sum, c) => sum + (c.file_size ?? 0), 0)
		: null;

	const baseHeaders = new Headers({
		'Content-Type': 'application/x-nix-nar',
		'Accept-Ranges': chunks.length === 1 ? 'bytes' : 'none'
	});

	if (head) {
		if (totalSize != null) baseHeaders.set('Content-Length', String(totalSize));
		return withVisibility(new Response(null, { status: 200, headers: baseHeaders }), isPublic);
	}

	if (chunks.length === 1) {
		const key = keys[0];
		const rangeHeader = request.headers.get('Range');
		const size = chunks[0].file_size ?? (await env.CACHE_BUCKET.head(key))?.size;

		if (rangeHeader && size != null) {
			const range = parseRange(rangeHeader, size);
			if (range === 'unsatisfiable') {
				baseHeaders.set('Content-Range', `bytes */${size}`);
				return withVisibility(new Response(null, { status: 416, headers: baseHeaders }), isPublic);
			}
			const object = await env.CACHE_BUCKET.get(key, { range });
			if (!object) return errorResponse(404, `File not found in storage: ${key}`);
			baseHeaders.set('Content-Length', String(range.length));
			baseHeaders.set(
				'Content-Range',
				`bytes ${range.offset}-${range.offset + range.length - 1}/${size}`
			);
			return withVisibility(
				new Response(object.body as unknown as BodyInit, { status: 206, headers: baseHeaders }),
				isPublic
			);
		}

		const object = await env.CACHE_BUCKET.get(key);
		if (!object) return errorResponse(404, `File not found in storage: ${key}`);
		baseHeaders.set('Content-Length', String(object.size));
		return withVisibility(
			new Response(object.body as unknown as BodyInit, { status: 200, headers: baseHeaders }),
			isPublic
		);
	}

	// Multi-chunk: stream the stored files back to back (zstd and gzip both
	// concatenate cleanly), prefetching the next object while the current one
	// is piped, like the reference server's chunk prefetcher.
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const pump = async () => {
		let next = env.CACHE_BUCKET.get(keys[0]);
		for (let i = 0; i < keys.length; i++) {
			const object = await next;
			if (i + 1 < keys.length) next = env.CACHE_BUCKET.get(keys[i + 1]);
			if (!object) throw new Error(`File not found in storage: ${keys[i]}`);
			await (object.body as unknown as ReadableStream<Uint8Array>).pipeTo(writable, {
				preventClose: true
			});
		}
		await writable.close();
	};
	const pumping = pump().catch((e) => writable.abort(e).catch(() => {}));
	ctx?.waitUntil(pumping);

	if (totalSize != null) baseHeaders.set('Content-Length', String(totalSize));
	return withVisibility(new Response(readable, { status: 200, headers: baseHeaders }), isPublic);
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
	if (!cache) return errorResponse(404, `Cache not found: ${body.cache}`, 'NoSuchCache');

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
		return handleGcTrigger(request, env, url);
	}

	// Everything below requires a token.
	const auth = await requireToken(request, env);
	if ('response' in auth) return auth.response;
	const token = auth.token;
	const canPush = (cacheName: string) => permissionForCache(token, cacheName).push;

	if (route === 'upload-path') {
		let response: Response;
		if (method === 'PUT' && segments.length === 3) {
			response = await handleUploadPath(request, env, canPush);
		} else if (method === 'POST' && segments[3] === 'start' && segments.length === 4) {
			const body = await (request.json() as Promise<{ nar_info?: never; nar_size?: number }>).catch(
				() => null
			);
			if (!body || !body.nar_info || typeof body.nar_size !== 'number') {
				return errorResponse(400, 'Invalid request body');
			}
			const info = body.nar_info as import('./upload').UploadNarInfo;
			if (!canPush(info.cache)) return errorResponse(403, 'Permission denied: push');
			response = await handleStartChunked(env, { nar_info: info, nar_size: body.nar_size });
		} else if (method === 'PUT' && segments[3] === 'chunk' && segments.length === 4) {
			response = await handleUploadChunk(request, env, canPush);
		} else if (method === 'POST' && segments[3] === 'complete' && segments.length === 4) {
			const body = await (request.json() as Promise<{ upload_token?: string }>).catch(() => null);
			if (!body?.upload_token) return errorResponse(400, 'Missing upload_token');
			response = await handleCompleteChunked(env, ctx, body.upload_token, canPush);
		} else {
			return errorResponse(404, 'Not found');
		}

		// Uploads grow storage: after one lands, check size budgets out-of-band
		// (debounced in maybeSizeTriggeredGc) instead of waiting for the cron.
		if (ctx && response.ok) ctx.waitUntil(maybeSizeTriggeredGc(env));
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
					(body ?? {}) as import('./cache-config').CreateCacheOptions
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
			return handleNarInfo(request, env, ctx, cacheName, rest, method === 'HEAD');
		}
	}

	if ((method === 'GET' || method === 'HEAD') && segments.length === 3 && segments[1] === 'nar') {
		return handleNar(request, env, ctx, segments[0], segments[2], method === 'HEAD');
	}

	return errorResponse(404, 'Not found');
}
