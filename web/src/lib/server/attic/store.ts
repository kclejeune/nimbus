// Cached read path of the binary-cache API, served behind the CachedStore
// entrypoint (worker-entry.ts) with Workers Caching enabled — on an edge cache
// hit none of this code runs, and neither D1 nor R2 is touched. Requests only
// arrive here after the gateway (router.ts) has authorized them, so nothing in
// this file may read Authorization or vary its output by caller.
//
// Workers Caching also owns Range handling: it strips Range before invoking
// the entrypoint, stores the full 200 response, and slices ranges itself — a
// Worker-returned 206 would never be stored, so no range logic lives here.

import * as db from './db';
import { errorResponse, withVisibility } from './http';
import { fetchUpstreamNarInfo, findUpstreamNar, parseUpstreams } from './missing-paths';
import { buildNarInfo } from './narinfo';

type Env = App.Platform['env'];
type ExecutionContext = App.Platform['ctx'];

// NAR URLs are content-addressed by nar hash, so a cached body can never go
// stale — cache for a year. A GC'd NAR served from cache is still valid data.
const NAR_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// narinfo bodies reference chunk keys that GC may reap, so bound the window in
// which a cached narinfo can point at storage that no longer exists.
const NARINFO_CACHE_CONTROL = 'public, max-age=86400';

export async function serveStore(
	request: Request,
	env: Env,
	ctx?: ExecutionContext
): Promise<Response> {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);

	if (segments.length === 2 && segments[1].endsWith('.narinfo')) {
		return serveNarInfo(env, segments[0], segments[1].slice(0, -'.narinfo'.length));
	}
	if (segments.length === 3 && segments[1] === 'nar') {
		return serveNar(env, ctx, segments[0], segments[2]);
	}
	return errorResponse(404, 'Not found');
}

async function serveNarInfo(env: Env, cacheName: string, storePathHash: string): Promise<Response> {
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	const [cache, found] = await Promise.all([
		db.findCache(env.ATTIC_DB, cacheName),
		db.findObject(env.ATTIC_DB, cacheName, storePathHash)
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
			return withVisibility(upstream, isPublic);
		}
		return errorResponse(404, 'Not found', 'NoSuchObject');
	}

	const chunks = await db.findChunksForNar(env.ATTIC_DB, found.nar.id);
	const narinfo = await buildNarInfo(found.object, found.nar, chunks, cache.keypair);

	return withVisibility(
		new Response(narinfo, {
			status: 200,
			headers: {
				'Content-Type': 'text/x-nix-narinfo',
				'Cache-Control': NARINFO_CACHE_CONTROL
			}
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

async function serveNar(
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheName: string,
	filename: string
): Promise<Response> {
	const narHashRaw = filename.split('.')[0];
	if (!narHashRaw) return errorResponse(400, 'Invalid NAR path');

	const [cache, nar] = await Promise.all([
		db.findCache(env.ATTIC_DB, cacheName),
		db
			.findNarByHash(env.ATTIC_DB, `sha256:${narHashRaw}`)
			.then((n) => n ?? db.findNarByHash(env.ATTIC_DB, narHashRaw))
	]);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');
	const isPublic = cache.is_public === 1;
	if (!nar) {
		// NAR URLs from passthrough narinfo (see serveNarInfo) resolve here:
		// redirect to the upstream copy rather than storing it.
		const upstreamUrl = await findUpstreamNar(
			parseUpstreams(cache.upstream_caches),
			`nar/${filename}`
		);
		if (upstreamUrl) return Response.redirect(upstreamUrl, 302);
		return errorResponse(404, 'Not found', 'NoSuchObject');
	}

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

	const baseHeaders = new Headers({
		'Content-Type': 'application/x-nix-nar',
		'Cache-Control': NAR_CACHE_CONTROL,
		'Accept-Ranges': 'bytes'
	});

	if (chunks.length === 1) {
		const object = await env.CACHE_BUCKET.get(keys[0]);
		if (!object) return errorResponse(404, `File not found in storage: ${keys[0]}`);
		baseHeaders.set('Content-Length', String(object.size));
		return withVisibility(
			new Response(object.body as unknown as BodyInit, { status: 200, headers: baseHeaders }),
			isPublic
		);
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
	return withVisibility(new Response(readable, { status: 200, headers: baseHeaders }), isPublic);
}
