// Cached read path of the binary-cache API, served behind the CachedStore
// entrypoint (worker-entry.ts) with Workers Caching enabled — on an edge cache
// hit none of this code runs, and neither D1 nor R2 is touched. Requests only
// arrive here after the gateway (router.ts) has authorized them, so nothing in
// this file may read Authorization or vary its output by caller.
//
// Workers Caching also owns Range handling: it strips Range before invoking
// the entrypoint, stores the full 200 response, and slices ranges itself — a
// Worker-returned 206 would never be stored, so no range logic lives here.

import { errorResponse, withVisibility } from '../attic/http';
import { buildNarInfo } from '../attic/narinfo';
import * as db from './db';
import { fetchUpstreamNarInfo, parseUpstreams } from './missing-paths';
import type { ExecutionContext } from './platform';

type Env = App.Platform['env'];

// NAR URLs are content-addressed by nar hash, so a cached body can never go
// stale — cache for a year. A GC'd NAR served from cache is still valid data.
const NAR_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// narinfo bodies reference chunk keys that GC may reap, but GC purges the
// narinfo tag of every object it deletes, so max-age only bounds staleness
// when a purge is missed (e.g. rate-limited). stale-while-revalidate refreshes
// expiring entries in the background instead of on the critical path.
const NARINFO_CACHE_CONTROL = 'public, max-age=2592000, stale-while-revalidate=86400';

/** Cache-Tag attached to narinfo responses; GC purges it on object deletion. */
export function narinfoTag(cacheName: string, storePathHash: string): string {
	return `narinfo:${cacheName}:${storePathHash}`;
}

/** Cache-wide tag on narinfo responses, for one-call purges when a config
 * change invalidates all of them at once (keypair rotation re-signs every
 * narinfo). */
export function cacheTag(cacheName: string): string {
	return `cache:${cacheName}`;
}

function narinfoTags(cacheName: string, storePathHash: string): string {
	return `${narinfoTag(cacheName, storePathHash)},${cacheTag(cacheName)}`;
}

export async function serveStore(
	request: Request,
	env: Env,
	ctx?: ExecutionContext
): Promise<Response> {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);

	if (segments.length === 2 && segments[1].endsWith('.narinfo')) {
		return serveNarInfo(request, env, ctx, segments[0], segments[1].slice(0, -'.narinfo'.length));
	}
	// NARs are content-addressed and shared across caches, so their route
	// carries no cache name: every cache referencing a NAR hits the same edge
	// entry, and R2 is read once instead of per cache. The gateway authorizes
	// against the requested cache and stamps visibility before forwarding here.
	if (segments.length === 2 && segments[0] === '_nar') {
		return serveNar(env, ctx, segments[1]);
	}
	return errorResponse(404, 'Not found');
}

// Predictive reference prefetch: a narinfo served here missed the edge cache,
// and Nix's closure walk (`nix copy`, substitution) will ask for the direct
// references next — warm them through the CachedStore loopback so the client
// only ever pays a cold miss every PREFETCH_DEPTH+1 levels of the walk. The
// depth header bounds recursion; each prefetched URL is one loopback fetch in
// THIS invocation, while deeper levels spend their own invocation's budget.
// Already-warm entries are served by the edge without running this code, so
// repeat prefetches of a warmed path cost nothing downstream.
// Internal-only: the gateway strips this header from client requests, so a
// caller can't start the recursion at an inflated depth.
export const PREFETCH_DEPTH_HEADER = 'X-Nimbus-Prefetch-Depth';
// DISABLED (depth 0) after the 2026-07-08 incident: under a mass query with a
// cold edge cache, per-miss fan-out (~25 clients x dozens of refs x depth 2)
// stormed D1 with loopback invocations and upstream-verdict writes, 500ing
// narinfo/NAR serving until the cache warmed. Re-enabling needs a global
// fan-out budget and no recursion — see docs/plans.
const PREFETCH_DEPTH = 0;
const PREFETCH_MAX_REFS = 64;

function prefetchReferences(
	ctx: ExecutionContext | undefined,
	request: Request,
	cacheName: string,
	servedHash: string,
	refsJson: string
): void {
	const store = ctx?.exports?.CachedStore;
	if (!store || !ctx?.waitUntil) return;
	const raw = request.headers.get(PREFETCH_DEPTH_HEADER);
	const depth = raw == null ? PREFETCH_DEPTH : Number(raw);
	if (!Number.isInteger(depth) || depth <= 0) return;

	let refs: unknown;
	try {
		refs = JSON.parse(refsJson);
	} catch {
		return;
	}
	if (!Array.isArray(refs)) return;
	const hashes = [
		...new Set(
			refs
				.filter((r): r is string => typeof r === 'string' && r.length >= 32)
				.map((r) => r.slice(0, 32))
		)
	]
		.filter((h) => h !== servedHash)
		.slice(0, PREFETCH_MAX_REFS);
	if (hashes.length === 0) return;

	// Reuse the request URL as the base so the gateway's ?pk= cache keying is
	// preserved — the warmed entries must land under the keys clients hit.
	const base = new URL(request.url);
	ctx.waitUntil(
		Promise.all(
			hashes.map(async (hash) => {
				const url = new URL(base);
				url.pathname = `/${cacheName}/${hash}.narinfo`;
				try {
					const res = await store.fetch(
						new Request(url, { headers: { [PREFETCH_DEPTH_HEADER]: String(depth - 1) } })
					);
					// narinfo bodies are tiny; consume so the cache write completes.
					await res.arrayBuffer();
				} catch {
					// best-effort
				}
			})
		)
	);
}

async function serveNarInfo(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheName: string,
	storePathHash: string
): Promise<Response> {
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	const [cache, found] = await Promise.all([
		db.findCache(env.ATTIC_DB, cacheName),
		db.findObjectWithChunks(env.ATTIC_DB, cacheName, storePathHash)
	]);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');
	const isPublic = cache.is_public === 1;
	if (!found) {
		// Paths available upstream are filtered out of pushes, so a complete
		// closure needs the upstream's narinfo served through this cache.
		const upstream = await fetchUpstreamNarInfo(
			env.ATTIC_DB,
			parseUpstreams(cache.upstream_caches),
			storePathHash
		);
		if (upstream) {
			upstream.headers.set('Cache-Control', NARINFO_CACHE_CONTROL);
			upstream.headers.set('Cache-Tag', narinfoTags(cacheName, storePathHash));
			return withVisibility(upstream, isPublic);
		}
		return errorResponse(404, 'Not found', 'NoSuchObject');
	}

	const narinfo = await buildNarInfo(found.object, found.nar, found.chunks, cache.keypair);
	prefetchReferences(ctx, request, cacheName, storePathHash, found.object.refs);

	return withVisibility(
		new Response(narinfo, {
			status: 200,
			headers: {
				'Content-Type': 'text/x-nix-narinfo',
				'Cache-Control': NARINFO_CACHE_CONTROL,
				'Cache-Tag': narinfoTags(cacheName, storePathHash)
			}
		}),
		isPublic
	);
}

async function serveNar(
	env: Env,
	ctx: ExecutionContext | undefined,
	filename: string
): Promise<Response> {
	const narHashRaw = filename.split('.')[0];
	if (!narHashRaw) return errorResponse(400, 'Invalid NAR path');

	const found = await db.findNarWithChunks(env.ATTIC_DB, [`sha256:${narHashRaw}`, narHashRaw]);
	if (!found) {
		// The gateway turns this 404 into an upstream redirect when the cache
		// has upstreams (passthrough narinfo NAR URLs resolve that way).
		return errorResponse(404, 'Not found', 'NoSuchObject');
	}

	const { nar, chunks } = found;
	if (chunks.length === 0) return errorResponse(500, 'NAR has no chunks');
	if (chunks.length < nar.num_chunks) {
		return errorResponse(503, 'Some chunks of this NAR are missing', 'IncompleteNar');
	}

	const keys: string[] = [];
	for (const chunk of chunks) {
		const key = db.chunkKey(chunk);
		if (!key) return errorResponse(500, 'No key in remote file');
		keys.push(key);
	}

	const baseHeaders = new Headers({
		'Content-Type': 'application/x-nix-nar',
		'Cache-Control': NAR_CACHE_CONTROL,
		'Accept-Ranges': 'bytes'
	});

	if (chunks.length === 1) {
		const object = await env.CACHE_BUCKET.get(keys[0]);
		if (!object) return errorResponse(404, `File not found in storage: ${keys[0]}`);
		baseHeaders.set('Content-Length', String(object.size));
		return new Response(object.body as unknown as BodyInit, { status: 200, headers: baseHeaders });
	}

	// Multi-chunk: stream the stored files back to back (zstd and gzip both
	// concatenate cleanly), prefetching the next object while the current one
	// is piped, like the reference server's chunk prefetcher.
	const totalSize = chunks.every((c) => c.file_size != null)
		? chunks.reduce((sum, c) => sum + (c.file_size ?? 0), 0)
		: null;
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
	return new Response(readable, { status: 200, headers: baseHeaders });
}
