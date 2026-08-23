import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	candidatesForNar,
	candidatesForStorePath,
	clearAbsent,
	invalidateProxyCandidates,
	isKnownAbsent,
	pickReadableWinner,
	proxyKeyName,
	recordAbsent,
	shouldTouch
} from './proxy';
import { TOUCH_GRANULARITY_MS, type LiveCacheRow } from './db';
import type { VerifiedToken, Permission } from '../attic/token';
import { NO_PERMISSION } from '../attic/token';

// Ids are distinct and deliberately not in name order: the winner is chosen by
// (priority, name), and nothing may quietly start ordering by id.
const rows = [
	{ id: 3, name: 'public-a', priority: 40, is_public: 1 },
	{ id: 1, name: 'private-b', priority: 30, is_public: 0 },
	{ id: 2, name: 'private-c', priority: 30, is_public: 0 }
];

function tokenWith(caches: Record<string, Partial<Permission>>): VerifiedToken {
	const map = new Map<string, Permission>();
	for (const [k, v] of Object.entries(caches)) map.set(k, { ...NO_PERMISSION, ...v });
	return { caches: map, gc: false, ct: false };
}

describe('pickReadableWinner', () => {
	it('anonymous resolves only against public caches', () => {
		expect(pickReadableWinner(null, rows)?.name).toBe('public-a');
		expect(pickReadableWinner(null, [rows[1]])).toBeNull();
	});
	it('a pull token widens the readable set by its patterns', () => {
		expect(pickReadableWinner(tokenWith({ 'private-*': { pull: true } }), rows)?.name).toBe(
			'private-b'
		);
	});
	it('non-pull bits do not grant read', () => {
		expect(pickReadableWinner(tokenWith({ 'private-b': { push: true } }), rows)?.name).toBe(
			'public-a'
		);
	});
	it('orders by priority then name', () => {
		const all = tokenWith({ '*': { pull: true } });
		expect(pickReadableWinner(all, rows)?.name).toBe('private-b');
		expect(pickReadableWinner(all, [rows[0], rows[2]])?.name).toBe('private-c');
	});
});

describe('absent-path memo', () => {
	afterEach(() => {
		vi.useRealTimers();
		clearAbsent('h1');
	});

	it('remembers absence until the TTL elapses', () => {
		vi.useFakeTimers();
		expect(isKnownAbsent('h1')).toBe(false);
		recordAbsent('h1');
		expect(isKnownAbsent('h1')).toBe(true);
		vi.advanceTimersByTime(61_000);
		expect(isKnownAbsent('h1')).toBe(false);
	});

	it('is cleared when an upload lands the path', () => {
		recordAbsent('h1');
		clearAbsent('h1');
		expect(isKnownAbsent('h1')).toBe(false);
	});
});

describe('root-proxy candidate memo', () => {
	// The memos are module-level and outlive each test, so every test resolves
	// fresh hashes instead of resetting shared state (same pattern as the
	// touch-coalescing tests below).
	let seq = 0;
	const freshHash = () => `hash-${seq++}`;
	afterEach(() => vi.useRealTimers());

	/** Minimal D1 stub for the prepare().bind().all() chain the candidate
	 * queries use, counting reads so the memo's effect is observable. */
	function candidateDb(rows: LiveCacheRow[]) {
		let reads = 0;
		const db = {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						reads++;
						return { results: rows };
					}
				})
			})
		} as never;
		return { db, reads: () => reads };
	}

	it('resolves store-path candidates once per TTL window', async () => {
		vi.useFakeTimers();
		const { db, reads } = candidateDb(rows);
		const hash = freshHash();
		expect(await candidatesForStorePath(db, hash)).toHaveLength(3);
		await candidatesForStorePath(db, hash);
		expect(reads()).toBe(1);
		vi.advanceTimersByTime(31_000);
		await candidatesForStorePath(db, hash);
		expect(reads()).toBe(2);
	});

	it('memoizes empty candidate sets too', async () => {
		const { db, reads } = candidateDb([]);
		const hash = freshHash();
		expect(await candidatesForStorePath(db, hash)).toEqual([]);
		await candidatesForStorePath(db, hash);
		expect(reads()).toBe(1);
	});

	it('coalesces concurrent misses without issuing duplicate D1 reads', async () => {
		const { db, reads } = candidateDb(rows);
		const hash = freshHash();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => candidatesForStorePath(db, hash))
		);
		expect(results.every((result) => result.length === 3)).toBe(true);
		expect(reads()).toBe(1);
	});

	it('clearAbsent evicts the store-path entry so an upload re-resolves', async () => {
		const { db, reads } = candidateDb(rows);
		const hash = freshHash();
		await candidatesForStorePath(db, hash);
		clearAbsent(hash);
		await candidatesForStorePath(db, hash);
		expect(reads()).toBe(2);
	});

	it('an upload evicts both store-path and NAR candidates', async () => {
		const { db, reads } = candidateDb(rows);
		const storePathHash = freshHash();
		const narHash = freshHash();
		await candidatesForStorePath(db, storePathHash);
		await candidatesForNar(db, narHash);
		expect(reads()).toBe(2);
		clearAbsent(storePathHash, `sha256:${narHash}`);
		await candidatesForStorePath(db, storePathHash);
		await candidatesForNar(db, narHash);
		expect(reads()).toBe(4);
	});

	it('cache-config invalidation clears both candidate memos', async () => {
		const { db, reads } = candidateDb(rows);
		const storePathHash = freshHash();
		const narHash = freshHash();
		await candidatesForStorePath(db, storePathHash);
		await candidatesForNar(db, narHash);
		invalidateProxyCandidates();
		await candidatesForStorePath(db, storePathHash);
		await candidatesForNar(db, narHash);
		expect(reads()).toBe(4);
	});

	it('coalesces takeover when a leader never settles', async () => {
		vi.useFakeTimers();
		let reads = 0;
		const db = {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						reads++;
						// The leader's read never settles — the shape of a request
						// context torn down mid-load, whose finally never runs.
						if (reads === 1) return await new Promise<never>(() => {});
						return { results: rows };
					}
				})
			})
		} as never;
		const hash = freshHash();
		void candidatesForStorePath(db, hash);
		const waiters = Array.from({ length: 8 }, () => candidatesForStorePath(db, hash));
		await vi.advanceTimersByTimeAsync(2_000);
		const results = await Promise.all(waiters);
		expect(results.every((result) => result.length === 3)).toBe(true);
		expect(reads).toBe(2);
	});

	it('does not let a superseded leader overwrite the takeover result', async () => {
		vi.useFakeTimers();
		let reads = 0;
		let releaseLeader!: (value: { results: LiveCacheRow[] }) => void;
		const staleRows = [rows[1]];
		const freshRows = [rows[0]];
		const db = {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						reads++;
						if (reads === 1) {
							return await new Promise<{ results: LiveCacheRow[] }>((resolve) => {
								releaseLeader = resolve;
							});
						}
						return { results: freshRows };
					}
				})
			})
		} as never;
		const hash = freshHash();
		const leader = candidatesForStorePath(db, hash);
		const waiters = Array.from({ length: 8 }, () => candidatesForStorePath(db, hash));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await Promise.all(waiters)).toEqual(Array.from({ length: 8 }, () => freshRows));
		expect(reads).toBe(2);

		releaseLeader({ results: staleRows });
		expect(await leader).toEqual(staleRows);
		expect(await candidatesForStorePath(db, hash)).toEqual(freshRows);
		expect(reads).toBe(2);
	});

	it('does not re-memoize a lookup invalidated while it is in flight', async () => {
		let reads = 0;
		let release!: (value: { results: LiveCacheRow[] }) => void;
		const db = {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						reads++;
						if (reads === 1) {
							return await new Promise<{ results: LiveCacheRow[] }>((resolve) => {
								release = resolve;
							});
						}
						return { results: rows };
					}
				})
			})
		} as never;
		const hash = freshHash();
		const stale = candidatesForStorePath(db, hash);
		invalidateProxyCandidates();
		release({ results: rows });
		await stale;
		await candidatesForStorePath(db, hash);
		expect(reads).toBe(2);
	});
});

describe('download-touch coalescing', () => {
	// Fresh NAR key per test so the per-isolate memo never carries across cases
	// (Date.now() is frozen under fake timers, so it can't provide uniqueness).
	let seq = 0;
	const freshNar = () => `nar-${seq++}`;
	afterEach(() => vi.useRealTimers());

	it('touches once per window, then again after it elapses', () => {
		vi.useFakeTimers();
		const nar = freshNar();
		expect(shouldTouch(1, nar)).toBe(true);
		// Repeats within the window are suppressed.
		expect(shouldTouch(1, nar)).toBe(false);
		expect(shouldTouch(1, nar)).toBe(false);
		// Just under the shared window still suppresses.
		vi.advanceTimersByTime(TOUCH_GRANULARITY_MS - 1000);
		expect(shouldTouch(1, nar)).toBe(false);
		// Past it, it touches again.
		vi.advanceTimersByTime(2000);
		expect(shouldTouch(1, nar)).toBe(true);
	});

	it('keys per cache so the same NAR touches each cache independently', () => {
		vi.useFakeTimers();
		const nar = freshNar();
		expect(shouldTouch(10, nar)).toBe(true);
		// Different cache, same NAR hash: not suppressed by cache 10's entry.
		expect(shouldTouch(11, nar)).toBe(true);
		expect(shouldTouch(10, nar)).toBe(false);
	});
});

describe('proxyKeyName', () => {
	it('derives from CACHE_BASE_URL host', () => {
		expect(proxyKeyName({ CACHE_BASE_URL: 'https://cache.kclj.io' } as never)).toBe(
			'cache.kclj.io-1'
		);
	});
	it('falls back when unset', () => {
		expect(proxyKeyName({} as never)).toBe('nimbus-proxy-1');
	});
});
