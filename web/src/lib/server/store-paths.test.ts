import { describe, expect, it } from 'vitest';
import { mulberry32, testDatabase } from './cache/test-db';
import { countAcrossCaches, newestAcrossCaches } from './store-paths';

// Reference oracle: sort the whole scope, then page.
const NAIVE_SQL = `SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size, c.name AS cache_name
 FROM object o
 JOIN cache c ON c.id = o.cache_id
 JOIN nar n ON n.id = o.nar_id
 WHERE o.cache_id IN (SELECT value FROM json_each(?))
 ORDER BY o.created_at DESC, o.store_path ASC
 LIMIT ? OFFSET ?`;

function seed(rand: () => number) {
	const { sqlite, db } = testDatabase();
	const now = '2026-09-01T00:00:00Z';
	sqlite.exec(`INSERT INTO nar (id, nar_hash, nar_size, created_at) VALUES (1, 'n', 42, '${now}')`);
	for (const cache of [1, 2, 3, 4]) {
		sqlite
			.prepare(`INSERT INTO cache (id, name, keypair, created_at) VALUES (?, ?, 'k', ?)`)
			.run(cache, `cache${cache}`, now);
		// Uneven sizes (one empty cache) and few distinct timestamps, so pages
		// straddle caches and ties between them are common.
		const n = cache === 4 ? 0 : Math.floor(rand() * 60);
		for (let i = 0; i < n; i++) {
			const day = String(1 + Math.floor(rand() * 5)).padStart(2, '0');
			const h = `${cache}${String(i).padStart(31, '0')}`;
			sqlite
				.prepare(
					`INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, created_at)
					 VALUES (?, 1, ?, ?, ?)`
				)
				.run(cache, h, `/nix/store/${h}-p${Math.floor(rand() * 20)}`, `2026-09-${day}T00:00:00Z`);
		}
	}
	return { sqlite, db };
}

describe('newestAcrossCaches', () => {
	it('pages exactly like sorting the whole scope', async () => {
		for (let s = 1; s <= 20; s++) {
			const rand = mulberry32(s);
			const { sqlite, db } = seed(rand);
			for (const ids of [[1], [1, 2], [2, 3, 4], [1, 2, 3, 4], [4]]) {
				for (const [limit, offset] of [
					[6, 0],
					[7, 7],
					[10, 25],
					[51, 50],
					[5, 500]
				]) {
					const expected = sqlite.prepare(NAIVE_SQL).all(JSON.stringify(ids), limit, offset);
					const actual = await newestAcrossCaches(db, ids, limit, offset);
					expect(actual, `seed ${s} ids ${ids} limit ${limit} offset ${offset}`).toEqual(
						expected.map((r) => ({ ...r }))
					);
				}
			}
		}
	});

	it('counts the scope and handles an empty one', async () => {
		const { sqlite, db } = seed(mulberry32(3));
		const n = (ids: number[]) =>
			Number(
				sqlite
					.prepare(
						`SELECT COUNT(*) AS n FROM object WHERE cache_id IN (${ids.join(',') || 'NULL'})`
					)
					.get()!.n
			);
		expect(await countAcrossCaches(db, [1, 3])).toBe(n([1, 3]));
		expect(await countAcrossCaches(db, [])).toBe(0);
		expect(await newestAcrossCaches(db, [], 6)).toEqual([]);
	});
});
