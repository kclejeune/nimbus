// A per-isolate, size-capped, TTL'd memo — the shape the server's read and
// push paths otherwise hand-roll repeatedly. (The upstream-config memo in
// missing-paths.ts stays hand-rolled on purpose: it memoizes a single
// in-flight PROMISE, a different shape.) Entries expire after their TTL; on
// reaching maxEntries it first sweeps expired keys, so a hot high-cardinality
// memo usually reclaims space without dropping live entries — the wholesale
// wipe (which for the download-touch memo regenerates the very D1 writes it
// exists to coalesce) remains only as the last resort when every entry is
// still live.
export class TtlMemo<V> {
	private readonly entries = new Map<string, { until: number; value: V }>();

	constructor(
		private readonly defaultTtlMs: number,
		private readonly maxEntries: number
	) {}

	/** The live value for `key`, or undefined when absent or expired. */
	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		if (Date.now() >= entry.until) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	/** Memoize `value` under `key` for `ttlMs` (defaults to the constructor's). */
	set(key: string, value: V, ttlMs: number = this.defaultTtlMs): void {
		if (this.entries.size >= this.maxEntries && !this.entries.has(key)) this.evict();
		this.entries.set(key, { until: Date.now() + ttlMs, value });
	}

	/** Drop one key. */
	delete(key: string): void {
		this.entries.delete(key);
	}

	/** Drop every entry. */
	clear(): void {
		this.entries.clear();
	}

	// Reclaim space without the wholesale-wipe cliff: drop expired entries
	// first, and only clear everything if still at capacity afterwards.
	private evict(): void {
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (now >= entry.until) this.entries.delete(key);
		}
		if (this.entries.size >= this.maxEntries) this.entries.clear();
	}
}
