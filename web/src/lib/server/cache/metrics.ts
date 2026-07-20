// Traffic metrics via Workers Analytics Engine. Read points are written in
// the gateway (router.ts), which runs on every request — edge-cache hits
// never reach the CachedStore entrypoint but do traverse the gateway, so the
// counts are complete. Push points are written by the client-push entry
// points in upload.ts (pull-through ingestion shares the inner helpers but is
// deliberately not counted as push traffic); chunk-level storage writes are
// recorded where the R2 put happens and do include pull-through. Unbound
// (dev/tests) or failing writes never affect serving.
//
// A read's `hit` means the content was found and served (locally stored, from
// the edge cache or built fresh); `upstream` marks responses whose content
// came from an upstream cache (passthrough narinfo 200s and NAR 302s alike);
// `miss` is a 404 — absent locally and upstream. Orthogonally, the edge blob
// records whether the CachedStore loopback was answered by the edge cache
// (blob4), which is the D1/R2-protection number.

type Env = App.Platform['env'];

export type ReadKind = 'narinfo' | 'nar';
export type ReadEvent = 'hit' | 'miss' | 'upstream' | 'other';
/**
 * Where the response came from relative to the edge cache: `hit` — served
 * from the edge without running CachedStore (STALE/UPDATING/REVALIDATED are
 * cache-served too); `origin` — CachedStore ran (D1, and R2 for NARs);
 * `bypass` — uncacheable response (no-store errors); `memo` — answered from
 * a per-isolate memo before any store fetch; `none` — no store fetch involved.
 */
export type EdgeEvent = 'hit' | 'origin' | 'bypass' | 'memo' | 'none';

/** Label reserved for the unified root endpoint (never a valid cache name —
 *  cache names must start alphanumeric). */
export const UNIFIED_LABEL = '_unified';

/** Label for storage-level write points: chunks are shared across caches, so
 *  chunk writes have no per-cache attribution. */
export const STORAGE_LABEL = '_storage';

/** Label for abuse-guard refusal points (instance-wide, like _storage). */
export const GUARD_LABEL = '_guard';

/** Which abuse guard refused: an upstream probe budget, an absent-verdict
 *  write budget, or a pull-through ingest budget. */
export type GuardEvent = 'probe' | 'verdict' | 'ingest';

function readEvent(status: number, viaUpstream: boolean): ReadEvent {
	if (viaUpstream) return 'upstream';
	if (status === 200 || status === 206 || status === 304) return 'hit';
	if (status === 404) return 'miss';
	if (status >= 300 && status < 400) return 'upstream';
	return 'other';
}

/** Classify the CF-Cache-Status header of a CachedStore loopback response. */
export function edgeEvent(cfCacheStatus: string | null): EdgeEvent {
	if (!cfCacheStatus) return 'none';
	switch (cfCacheStatus.toUpperCase()) {
		case 'HIT':
		case 'STALE':
		case 'UPDATING':
		case 'REVALIDATED':
			return 'hit';
		case 'MISS':
		case 'EXPIRED':
			return 'origin';
		default:
			return 'bypass';
	}
}

/** Record one gateway read. `viaUpstream` marks responses whose content came
 *  from an upstream regardless of status (a redirect about to be issued, or a
 *  narinfo passthrough 200); `edge` is the loopback's cache verdict. */
export function recordRead(
	env: Env,
	kind: ReadKind,
	cache: string,
	outcome: { status: number; viaUpstream?: boolean; edge?: EdgeEvent }
): void {
	try {
		env.CACHE_METRICS?.writeDataPoint({
			blobs: [
				kind,
				readEvent(outcome.status, outcome.viaUpstream ?? false),
				cache,
				outcome.edge ?? 'none'
			],
			doubles: [1],
			indexes: [cache]
		});
	} catch {
		// Metrics must never fail a read.
	}
}

/** Record one completed push: a store path landing in a cache, either by
 *  storing a fresh NAR or by reusing content already present (NAR-level
 *  dedup). `narBytes` is the logical NAR size, so byte totals line up with
 *  the storage charts rather than wire compression. */
export function recordPush(
	env: Env,
	cache: string,
	outcome: { deduplicated: boolean; narBytes: number }
): void {
	try {
		env.CACHE_METRICS?.writeDataPoint({
			blobs: ['push', outcome.deduplicated ? 'deduplicated' : 'stored', cache],
			doubles: [1, outcome.narBytes],
			indexes: [cache]
		});
	} catch {
		// Metrics must never fail a push.
	}
}

/** Record one chunk-level storage write, at the site of the R2 put: `stored`
 *  is a fresh compressed chunk landing in R2 (`fileBytes` = bytes written,
 *  and each event is one R2 Class A op); `deduplicated` is a chunk that
 *  matched an existing row (`fileBytes` = compressed bytes avoided). Unlike
 *  push points this includes pull-through ingestion — it measures what hits
 *  storage, not what clients push. */
export function recordStoreWrite(
	env: Env,
	outcome: { deduplicated: boolean; fileBytes: number }
): void {
	try {
		env.CACHE_METRICS?.writeDataPoint({
			blobs: ['chunk', outcome.deduplicated ? 'deduplicated' : 'stored', STORAGE_LABEL],
			doubles: [1, outcome.fileBytes],
			indexes: [STORAGE_LABEL]
		});
	} catch {
		// Metrics must never fail an upload.
	}
}

/** Record one abuse-guard refusal, so deflected abuse is visible on the
 *  monitoring page instead of only as absent load. */
export function recordGuard(env: Env, event: GuardEvent): void {
	try {
		env.CACHE_METRICS?.writeDataPoint({
			blobs: ['guard', event, GUARD_LABEL],
			doubles: [1],
			indexes: [GUARD_LABEL]
		});
	} catch {
		// Metrics must never fail the guarded path.
	}
}
