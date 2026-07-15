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
import { extractPublicKey } from '../attic/signing';
import { findCacheCached } from './cache-lookup';
import * as db from './db';
import {
	allLiveUpstreams,
	fetchUpstreamNarInfo,
	upstreamsForCache,
	upstreamTtlSecs,
	type Upstream
} from './missing-paths';
import { clearAbsent, getProxyKeypair } from './proxy';
import type { ExecutionContext } from './platform';

type Env = App.Platform['env'];

// NAR URLs are content-addressed by nar hash, so a cached body can never go
// stale — cache for a year. A GC'd NAR served from cache is still valid data.
const NAR_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// narinfo entries are invalidated actively — GC purges the tag of every
// object it deletes, uploads purge+rewarm on (re-)push, and keypair rotation
// re-keys via ?pk — so max-age only bounds staleness when a purge is missed
// (e.g. rate-limited during a mass sweep), and the worst case of that is a
// narinfo whose NAR has been reaped: the client falls back to building.
// stale-while-revalidate refreshes expiring entries off the critical path;
// stale-if-error keeps serving through origin incidents where honored.
const NARINFO_CACHE_CONTROL =
	'public, max-age=7776000, stale-while-revalidate=86400, stale-if-error=86400';
// Negative caching: absent paths (mostly upstream-filtered references) are
// re-queried by every closure walk, so an uncacheable 404 sends each walk to
// D1 for the whole set. The 404 carries the same narinfo tag a real entry
// would, and uploads purge it (warmNarinfoAfterUpload), so a landed path
// becomes visible immediately; max-age bounds the invisibility when that
// purge is missed (worst case: the next CI run rebuilds the path and the
// re-push dedups server-side).
const NARINFO_404_CACHE_CONTROL = 'public, max-age=1800';

/**
 * Cache-Control for upstream passthrough narinfos: the edge holds them for
 * the upstream's TTL, then revalidates by re-invoking this worker, which
 * re-fetches the upstream live — CDN-driven revalidation, no cron involved.
 * An entry the upstream GC'd flips to a (cacheable, tagged) 404 at the next
 * revalidation, so staleness is bounded by the TTL.
 */
function upstreamNarinfoCacheControl(upstream: Upstream): string {
	const ttl = upstreamTtlSecs(upstream);
	return `public, max-age=${ttl}, stale-while-revalidate=86400, stale-if-error=86400`;
}

/**
 * The shared response for an upstream passthrough narinfo (per-cache and
 * root proxy): served verbatim with the upstream's own signature, edge-cached
 * for the upstream's TTL, marked for pull-through when the winning upstream
 * resolves to a persist cache.
 */
function upstreamNarinfoResponse(
	hit: { text: string; upstream: Upstream },
	tags: string
): Response {
	const response = new Response(hit.text, {
		status: 200,
		headers: {
			'Content-Type': 'text/x-nix-narinfo',
			'Cache-Control': upstreamNarinfoCacheControl(hit.upstream),
			'Cache-Tag': tags
		}
	});
	if (hit.upstream.persistInto) {
		response.headers.set(PERSIST_CACHE_HEADER, hit.upstream.persistInto);
		response.headers.set(PERSIST_UPSTREAM_HEADER, hit.upstream.url);
	}
	return response;
}

/**
 * Internal response headers asking the gateway to pull-through this
 * passthrough into a cache. waitUntil work registered here in the RPC callee
 * is cancelled when the RPC session ends, so the download must ride the
 * gateway's execution context — the gateway reads these, spawns the ingest,
 * and strips them before responding. They are edge-cached with the entry, so
 * hits keep re-asking until ingestion lands and evicts the entry; ingest is
 * idempotent and exits early once the object exists.
 */
export const PERSIST_CACHE_HEADER = 'X-Nimbus-Persist-Cache';
export const PERSIST_UPSTREAM_HEADER = 'X-Nimbus-Persist-Upstream';

/** Cache-Tag attached to narinfo responses; GC purges it on object deletion. */
export function narinfoTag(cacheName: string, storePathHash: string): string {
	return `narinfo:${cacheName}:${storePathHash}`;
}

/**
 * Tag namespace for root-proxy upstream passthroughs. `~` is outside
 * CACHE_NAME_RE, so it can never collide with a real cache's tags; the
 * upstream revalidator purges these when an upstream GCs an entry.
 */
export const ROOT_UPSTREAM_TAG_NS = '~upstream';

/** Cache-wide tag on narinfo responses, for one-call purges when a config
 * change invalidates all of them at once (keypair rotation re-signs every
 * narinfo). */
export function cacheTag(cacheName: string): string {
	return `cache:${cacheName}`;
}

/**
 * Extra tag on upstream passthrough narinfos only: upstream config changes
 * (registry edits, subscription mode changes) purge this instead of the whole
 * cacheTag, so locally-stored narinfos — whose bytes didn't change — stay
 * warm at the edge instead of cold-starting a mass-query stampede into D1.
 */
export function upstreamPassthroughTag(cacheName: string): string {
	return `upstream-pt:${cacheName}`;
}

function narinfoTags(cacheName: string, storePathHash: string): string {
	return `${narinfoTag(cacheName, storePathHash)},${cacheTag(cacheName)}`;
}

/**
 * narinfo URL as the gateway keys it for the edge cache: the pk param ties
 * cached entries to the signing identity, so keypair rotation invalidates
 * them instantly (see handleNarInfo in router.ts).
 */
export function keyedNarinfoUrl(
	origin: string,
	cacheName: string,
	storePathHash: string,
	keypair: string | null
): URL {
	const url = new URL(`${origin}/${cacheName}/${storePathHash}.narinfo`);
	if (keypair) {
		try {
			url.searchParams.set('pk', extractPublicKey(keypair));
		} catch {
			// no valid keypair: stored client sigs are served, nothing to vary on
		}
	}
	return url;
}

/**
 * After an upload lands an object, purge its narinfo tag (covering both a
 * negatively-cached 404 and a stale narinfo from re-pushing an existing
 * path), then re-fetch through the loopback so the edge holds the fresh
 * entry before the next closure walk asks. O(1) per upload, best-effort:
 * on failure the entry corrects itself when the 404 TTL or purge lands.
 */
export async function warmNarinfoAfterUpload(
	ctx: ExecutionContext | undefined,
	origin: string,
	cache: { name: string; keypair: string | null },
	storePathHash: string
): Promise<void> {
	// The root proxy's negative memo is per-isolate; this clears it where the
	// upload landed, and the TTL bounds the others.
	clearAbsent(storePathHash);
	const store = ctx?.exports?.CachedStore;
	if (!store) return;
	try {
		// The root ~upstream tag evicts a lingering root-proxy passthrough of
		// the same path (uploads and pull-through ingestion both land here).
		await store.purgeTags([
			narinfoTag(cache.name, storePathHash),
			narinfoTag(ROOT_UPSTREAM_TAG_NS, storePathHash)
		]);
	} catch {
		// stale entry expires via its max-age
	}
	try {
		const res = await store.fetch(
			new Request(keyedNarinfoUrl(origin, cache.name, storePathHash, cache.keypair))
		);
		await res.arrayBuffer();
	} catch {
		// best-effort: the next client miss populates the entry instead
	}
}

export async function serveStore(
	request: Request,
	env: Env,
	ctx?: ExecutionContext
): Promise<Response> {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);

	// Root-proxy upstream fallback: the hash resolves to no local cache, so try
	// the union of every live cache's upstreams. Cached at the edge under this
	// internal path so mass queries for upstream-available paths don't re-probe.
	// Must precede the per-cache narinfo route, which would otherwise match
	// this path shape and read '_proxy_upstream' as a cache name.
	if (
		segments.length === 2 &&
		segments[0] === '_proxy_upstream' &&
		segments[1].endsWith('.narinfo')
	) {
		return serveRootUpstreamNarInfo(env, ctx, segments[1].slice(0, -'.narinfo'.length));
	}
	if (segments.length === 2 && segments[1].endsWith('.narinfo')) {
		return serveNarInfo(request, env, ctx, segments[0], segments[1].slice(0, -'.narinfo'.length));
	}
	// Root-proxy narinfo: same object, re-signed with the proxy keypair, cached
	// under a distinct internal path so per-cache entries never collide.
	if (segments.length === 3 && segments[0] === '_proxy' && segments[2].endsWith('.narinfo')) {
		return serveProxyNarInfo(env, segments[1], segments[2].slice(0, -'.narinfo'.length));
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

async function serveProxyNarInfo(
	env: Env,
	cacheName: string,
	storePathHash: string
): Promise<Response> {
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	const session = db.readSession(env.ATTIC_DB);
	const [cache, found, keypair] = await Promise.all([
		findCacheCached(session, cacheName),
		db.findObjectWithChunks(session, cacheName, storePathHash),
		getProxyKeypair(env).catch((e) => {
			console.warn(`proxy keypair unavailable, serving stored sigs: ${e}`);
			return null;
		})
	]);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');
	// The gateway resolved this object before forwarding, so a miss here is a
	// deletion race — no upstream fallback at the root, no negative caching.
	if (!found) return errorResponse(404, 'Not found', 'NoSuchObject');

	const narinfo = await buildNarInfo(found.object, found.nar, found.chunks, keypair);

	// Same tags as the per-cache entry: GC/upload purges cover both.
	return narinfoResponse(narinfo, cacheName, storePathHash, cache.is_public === 1);
}

/**
 * Root-proxy upstream passthrough: serve the upstream's narinfo verbatim (its
 * signature is the upstream's own, which clients substituting through the
 * root already trust — nothing is re-signed). Upstream content is public, so
 * responses are always cacheable; both hits and misses carry the
 * ROOT_UPSTREAM_TAG_NS tag so ingestion can evict them once a path lands
 * locally.
 */
async function serveRootUpstreamNarInfo(
	env: Env,
	ctx: ExecutionContext | undefined,
	storePathHash: string
): Promise<Response> {
	if (storePathHash.length !== 32) return errorResponse(400, 'Invalid store path hash');

	const session = db.readSession(env.ATTIC_DB);
	const upstreams = await allLiveUpstreams(session);
	// The cache-wide ~upstream tag lets registry changes purge every root
	// passthrough in one call, like cacheTag() does for a real cache.
	const tag = `${narinfoTag(ROOT_UPSTREAM_TAG_NS, storePathHash)},${cacheTag(ROOT_UPSTREAM_TAG_NS)}`;

	const hit =
		upstreams.length > 0
			? await fetchUpstreamNarInfo(session, upstreams, storePathHash, ctx)
			: null;
	if (hit) return withVisibility(upstreamNarinfoResponse(hit, tag), true);
	const absent = errorResponse(404, 'Not found', 'NoSuchObject');
	absent.headers.set('Cache-Control', NARINFO_404_CACHE_CONTROL);
	absent.headers.set('Cache-Tag', tag);
	return withVisibility(absent, true);
}

/** The shared success response for a served narinfo (per-cache and root proxy). */
function narinfoResponse(
	narinfo: string,
	cacheName: string,
	storePathHash: string,
	isPublic: boolean
): Response {
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

	const session = db.readSession(env.ATTIC_DB);
	const [cache, found] = await Promise.all([
		findCacheCached(session, cacheName),
		db.findObjectWithChunks(session, cacheName, storePathHash)
	]);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');
	const isPublic = cache.is_public === 1;
	if (!found) {
		// Paths available upstream are filtered out of pushes, so a complete
		// closure needs the upstream's narinfo served through this cache. A
		// persist-mode subscription resolves into this cache (upstreamsForCache
		// sets persistInto).
		const upstreams = await upstreamsForCache(session, cache);
		const hit = await fetchUpstreamNarInfo(session, upstreams, storePathHash, ctx);
		if (hit) {
			return withVisibility(
				upstreamNarinfoResponse(
					hit,
					`${narinfoTags(cacheName, storePathHash)},${upstreamPassthroughTag(cacheName)}`
				),
				isPublic
			);
		}
		const absent = errorResponse(404, 'Not found', 'NoSuchObject');
		absent.headers.set('Cache-Control', NARINFO_404_CACHE_CONTROL);
		absent.headers.set('Cache-Tag', narinfoTags(cacheName, storePathHash));
		return withVisibility(absent, isPublic);
	}

	const narinfo = await buildNarInfo(found.object, found.nar, found.chunks, cache.keypair);
	prefetchReferences(ctx, request, cacheName, storePathHash, found.object.refs);

	return narinfoResponse(narinfo, cacheName, storePathHash, isPublic);
}

async function serveNar(
	env: Env,
	ctx: ExecutionContext | undefined,
	filename: string
): Promise<Response> {
	const narHashRaw = filename.split('.')[0];
	if (!narHashRaw) return errorResponse(400, 'Invalid NAR path');

	const found = await db.findNarWithChunks(db.readSession(env.ATTIC_DB), [
		`sha256:${narHashRaw}`,
		narHashRaw
	]);
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
