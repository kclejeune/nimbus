import { describe, expect, it, vi } from 'vitest';
import { mulberry32, testDatabase } from './test-db';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

import { syncObjectRefs } from './gc';

const hashOf = (i: number) => `h${String(i).padStart(31, '0')}`;

/**
 * Pushes in random order across two caches (a path's references may land
 * before or after it, in either cache, or never), synced between batches
 * the way GC runs and path removals interleave with pushes.
 */
async function pushAndSync(seed: number) {
	const { sqlite, db } = testDatabase();
	const rand = mulberry32(seed);
	const now = '2026-09-01T00:00:00Z';
	sqlite.exec(`INSERT INTO nar (id, nar_hash, nar_size, created_at) VALUES (1, 'n', 1, '${now}')`);
	for (const cache of [1, 2]) {
		sqlite
			.prepare(`INSERT INTO cache (id, name, keypair, created_at) VALUES (?, ?, 'k', ?)`)
			.run(cache, `cache${cache}`, now);
	}
	// A universe of 60 paths, each referencing a few others (and sometimes
	// itself); 20% are never pushed anywhere, like upstream-served paths.
	const refs = Array.from({ length: 60 }, (_, i) => {
		const r = new Set<number>();
		for (let k = 0; k < Math.floor(rand() * 5); k++) r.add(Math.floor(rand() * 60));
		if (rand() < 0.3) r.add(i);
		return [...r];
	});
	const pushes = [1, 2]
		.flatMap((cache) =>
			refs.map((_, i) => ({ cache, i })).filter(({ i }) => i % 5 !== 0 && rand() < 0.7)
		)
		.sort(() => rand() - 0.5);
	const insert = sqlite.prepare(
		`INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, refs, created_at)
		 VALUES (?, 1, ?, ?, ?, ?)`
	);
	for (let k = 0; k < pushes.length; k++) {
		const { cache, i } = pushes[k];
		const paths = refs[i].map((j) => `${hashOf(j)}-p${j}`);
		insert.run(cache, hashOf(i), `/nix/store/${hashOf(i)}-p${i}`, JSON.stringify(paths), now);
		if (rand() < 0.15) await syncObjectRefs(db);
	}
	await syncObjectRefs(db);
	return sqlite;
}

describe('syncObjectRefs', () => {
	it('links every edge to its child in the same cache, whatever the push order', async () => {
		for (let seed = 1; seed <= 25; seed++) {
			const sqlite = await pushAndSync(seed);
			// Ground truth from scratch: one edge per non-self reference,
			// resolved to that hash's object in the parent's cache, if any.
			const expected = sqlite
				.prepare(
					`SELECT o.id AS object_id, substr(j.value, 1, 32) AS ref_hash,
					        (SELECT c.id FROM object c WHERE c.cache_id = o.cache_id
					          AND c.store_path_hash = substr(j.value, 1, 32)) AS child_id
					 FROM object o, json_each(o.refs) j
					 WHERE substr(j.value, 1, 32) <> o.store_path_hash
					 ORDER BY 1, 2`
				)
				.all();
			const actual = sqlite
				.prepare('SELECT object_id, ref_hash, child_id FROM object_ref ORDER BY 1, 2')
				.all();
			expect(actual, `seed ${seed}`).toEqual(expected);
			expect(expected.some((e) => e.child_id === null)).toBe(true);
		}
	});
});
