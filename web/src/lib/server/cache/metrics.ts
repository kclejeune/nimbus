// Read-path traffic metrics via Workers Analytics Engine. Points are written
// in the gateway (router.ts), which runs on every request — edge-cache hits
// never reach the CachedStore entrypoint but do traverse the gateway, so the
// counts are complete. Unbound (dev/tests) or failing writes never affect
// serving.
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

export function readEvent(status: number): ReadEvent {
	if (status === 200 || status === 206 || status === 304) return 'hit';
	if (status === 404) return 'miss';
	if (status >= 300 && status < 400) return 'upstream';
	return 'other';
}

export function recordRead(env: Env, kind: ReadKind, cache: string, event: ReadEvent): void {
	try {
		env.CACHE_METRICS?.writeDataPoint({
			blobs: [kind, event, cache],
			doubles: [1],
			indexes: [cache]
		});
	} catch {
		// Metrics must never fail a read.
	}
}
