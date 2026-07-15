import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { findCacheCached, invalidateCacheRow } from './cache-lookup';
import type { CacheRow } from './db';

const ROW: CacheRow = {
	id: 1,
	name: 'demo',
	keypair: 'demo-1:abc',
	is_public: 1,
	store_dir: '/nix/store',
	priority: 40,
	upstream_cache_key_names: '[]',
	compression: 'zstd',
	retention_period: null,
	retention_max_bytes: null
};

/**
 * Minimal D1 stub exercising only the prepare().bind().first() chain findCache
 * uses, counting how many times a row is actually read so the memo's effect is
 * observable. `row` is returned for any lookup; the memo keys on the name
 * argument, so tests distinguish entries by passing different names.
 */
function fakeDb(row: CacheRow | null): { db: D1Database; reads: () => number } {
	let reads = 0;
	const db = {
		prepare: () => ({
			bind: () => ({
				first: async () => {
					reads++;
					return row;
				}
			})
		})
	} as unknown as D1Database;
	return { db, reads: () => reads };
}

describe('findCacheCached', () => {
	afterEach(() => {
		vi.useRealTimers();
		invalidateCacheRow();
	});

	it('reads once, then serves the memo within the TTL', async () => {
		vi.useFakeTimers();
		const { db, reads } = fakeDb(ROW);
		expect((await findCacheCached(db, 'hit'))?.id).toBe(1);
		expect(await findCacheCached(db, 'hit')).toBeTruthy();
		expect(reads()).toBe(1);
		// Just under the 30s TTL still hits the memo.
		vi.advanceTimersByTime(20_000);
		await findCacheCached(db, 'hit');
		expect(reads()).toBe(1);
		// Past the TTL re-reads.
		vi.advanceTimersByTime(11_000);
		await findCacheCached(db, 'hit');
		expect(reads()).toBe(2);
	});

	it('invalidateCacheRow forces a fresh read', async () => {
		const { db, reads } = fakeDb(ROW);
		await findCacheCached(db, 'inv');
		await findCacheCached(db, 'inv');
		expect(reads()).toBe(1);
		invalidateCacheRow('inv');
		await findCacheCached(db, 'inv');
		expect(reads()).toBe(2);
	});

	it('remembers a miss only briefly so create-then-serve resolves fast', async () => {
		vi.useFakeTimers();
		const { db, reads } = fakeDb(null);
		expect(await findCacheCached(db, 'gone')).toBeNull();
		await findCacheCached(db, 'gone');
		expect(reads()).toBe(1);
		// Miss TTL is 5s — shorter than the hit TTL.
		vi.advanceTimersByTime(6_000);
		await findCacheCached(db, 'gone');
		expect(reads()).toBe(2);
	});
});
