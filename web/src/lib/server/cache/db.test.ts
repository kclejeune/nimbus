import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { findExistingChunkHashes, PARAM_BATCH } from './db';

/** Minimal D1 stub for the prepare().bind() + batch() chain, echoing every
 * bound hash back as existing and recording how statements were batched. */
function fakeDb() {
	const batchCalls: number[] = [];
	const db = {
		prepare: (sql: string) => ({
			bind: (...params: unknown[]) => ({ sql, params })
		}),
		batch: async (stmts: { params: unknown[] }[]) => {
			batchCalls.push(stmts.length);
			return stmts.map((s) => ({
				// params[0] is the compression; the rest are the window's hashes.
				results: (s.params.slice(1) as string[]).map((chunk_hash) => ({ chunk_hash }))
			}));
		}
	} as unknown as D1Database;
	return { db, batchCalls };
}

describe('findExistingChunkHashes', () => {
	it('windows the IN lists but sends them in one batch round-trip', async () => {
		const hashes = Array.from({ length: PARAM_BATCH * 2 + 1 }, (_, i) => `sha256:${i}`);
		const { db, batchCalls } = fakeDb();
		const existing = await findExistingChunkHashes(db, hashes, 'zstd');
		expect(existing.size).toBe(hashes.length);
		expect(existing.has('sha256:0')).toBe(true);
		expect(existing.has(`sha256:${PARAM_BATCH * 2}`)).toBe(true);
		// Three IN-windows, one db.batch call — not one round-trip per window.
		expect(batchCalls).toEqual([3]);
	});

	it('returns an empty set for no hashes without touching the db', async () => {
		const { db, batchCalls } = fakeDb();
		expect((await findExistingChunkHashes(db, [], 'zstd')).size).toBe(0);
		expect(batchCalls).toEqual([]);
	});
});
