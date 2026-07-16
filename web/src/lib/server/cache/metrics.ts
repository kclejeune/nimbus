// Traffic metrics via Workers Analytics Engine. Read points are written in
// the gateway (router.ts), which runs on every request — edge-cache hits
// never reach the CachedStore entrypoint but do traverse the gateway, so the
// counts are complete. Push points are written by the client-push entry
// points in upload.ts (pull-through ingestion shares the inner helpers but is
// deliberately not counted as push traffic). Unbound (dev/tests) or failing
// writes never affect serving.
//
// Classification is by response status, so redirect-tier narinfo passthroughs
// (200s whose content came from an upstream) count as hits; the upstream
// share of traffic is visible through NAR 302s, which is where the bytes
// actually diverge to the upstream.

type Env = App.Platform['env'];

export type ReadKind = 'narinfo' | 'nar';
export type ReadEvent = 'hit' | 'miss' | 'upstream' | 'other';

/** Label reserved for the unified root endpoint (never a valid cache name —
 *  cache names must start alphanumeric). */
export const UNIFIED_LABEL = '_unified';

function readEvent(status: number, viaUpstream: boolean): ReadEvent {
	if (viaUpstream) return 'upstream';
	if (status === 200 || status === 206 || status === 304) return 'hit';
	if (status === 404) return 'miss';
	if (status >= 300 && status < 400) return 'upstream';
	return 'other';
}

/** Record one gateway read. `viaUpstream` marks responses whose content came
 *  from an upstream regardless of status (a redirect about to be issued, or a
 *  200 served through the union-of-upstreams fallback). */
export function recordRead(
	env: Env,
	kind: ReadKind,
	cache: string,
	outcome: { status: number; viaUpstream?: boolean }
): void {
	try {
		env.CACHE_METRICS?.writeDataPoint({
			blobs: [kind, readEvent(outcome.status, outcome.viaUpstream ?? false), cache],
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
