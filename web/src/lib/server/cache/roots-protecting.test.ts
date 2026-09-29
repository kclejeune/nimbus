import { describe, expect, it, vi } from 'vitest';
import { mulberry32, testDatabase } from './test-db';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

import { rootsProtecting, type ProtectingRoot } from './gc';

// The path page's previous formulation: a forward walk from every gc_root in
// the cache, tagged by root. rootsProtecting walks up instead; on any graph
// the two must name the same roots.
const FORWARD_SQL = `WITH RECURSIVE prot(root, id) AS (
   SELECT g.store_path_hash, o.id FROM gc_root g
     JOIN object o ON o.cache_id = g.cache_id AND o.store_path_hash = g.store_path_hash
    WHERE g.cache_id = ?1
   UNION
   SELECT p.root, r.child_id FROM prot p
     JOIN object_ref r ON r.object_id = p.id
    WHERE r.child_id IS NOT NULL
 )
 SELECT DISTINCT d.root AS hash, o.store_path, pn.name AS pin_name
 FROM (SELECT DISTINCT root FROM prot WHERE id = ?2) d
 JOIN object o ON o.cache_id = ?1 AND o.store_path_hash = d.root
 JOIN gc_root g ON g.cache_id = ?1 AND g.store_path_hash = d.root
 LEFT JOIN pin pn ON pn.id = g.pin_id`;

const hashOf = (cache: number, i: number) => `c${cache}-${String(i).padStart(29, '0')}`;

function seedGraph(seed: number) {
	const { sqlite, db } = testDatabase();
	const rand = mulberry32(seed);
	const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
	const now = '2026-09-01T00:00:00Z';

	sqlite.exec(`INSERT INTO nar (id, nar_hash, nar_size, created_at) VALUES (1, 'n', 1, '${now}')`);
	const objectIds: Record<number, number[]> = {};
	for (const cache of [1, 2]) {
		sqlite
			.prepare(`INSERT INTO cache (id, name, keypair, created_at) VALUES (?, ?, 'k', ?)`)
			.run(cache, `cache${cache}`, now);
		const n = 15 + Math.floor(rand() * 25);
		objectIds[cache] = [];
		for (let i = 0; i < n; i++) {
			const h = hashOf(cache, i);
			const { lastInsertRowid } = sqlite
				.prepare(
					`INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, created_at)
					 VALUES (?, 1, ?, ?, ?)`
				)
				.run(cache, h, `/nix/store/${h}-p${i}`, now);
			const id = Number(lastInsertRowid);
			objectIds[cache].push(id);
			// Edges only to earlier objects (a DAG, like a closure), plus the
			// self-references real store paths carry and dangling references
			// to paths the cache doesn't hold.
			const refs = new Map<string, number | null>();
			for (let k = 0; k < Math.floor(rand() * 4); k++) {
				if (i > 0) {
					const j = Math.floor(rand() * i);
					refs.set(hashOf(cache, j), objectIds[cache][j]);
				}
			}
			if (rand() < 0.3) refs.set(h, id);
			if (rand() < 0.2) refs.set(`missing-${seed}-${i}`, null);
			for (const [ref, child] of refs) {
				sqlite
					.prepare('INSERT INTO object_ref (object_id, ref_hash, child_id) VALUES (?, ?, ?)')
					.run(id, ref, child);
			}
		}
		// Roots: quick pins, named pins with several revisions, and a root
		// whose path isn't in the cache.
		const pinId = Number(
			sqlite
				.prepare(`INSERT INTO pin (cache_id, name, created_at) VALUES (?, ?, ?)`)
				.run(cache, `pin${cache}`, now).lastInsertRowid
		);
		const root = (hash: string, pin: number | null) =>
			sqlite
				.prepare(
					'INSERT OR IGNORE INTO gc_root (cache_id, store_path_hash, pin_id, created_at) VALUES (?, ?, ?, ?)'
				)
				.run(cache, hash, pin, now);
		for (let k = 0; k < 1 + Math.floor(rand() * 3); k++)
			root(hashOf(cache, pick([...Array(n).keys()])), null);
		for (let k = 0; k < 1 + Math.floor(rand() * 3); k++)
			root(hashOf(cache, pick([...Array(n).keys()])), pinId);
		root(`absent-${cache}`, null);
	}
	return { sqlite, db, objectIds };
}

const sorted = (rows: ProtectingRoot[]) =>
	rows
		.map((r) => ({ hash: r.hash, store_path: r.store_path, pin_name: r.pin_name }))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('rootsProtecting', () => {
	it('names the same roots as a forward walk from every root', async () => {
		let compared = 0;
		let nonEmpty = 0;
		for (let seed = 1; seed <= 40; seed++) {
			const { sqlite, db, objectIds } = seedGraph(seed);
			for (const cache of [1, 2]) {
				for (const id of objectIds[cache]) {
					const expected = sqlite
						.prepare(FORWARD_SQL)
						.all(cache, id) as unknown as ProtectingRoot[];
					const actual = await rootsProtecting(db, cache, id);
					expect(sorted(actual), `seed ${seed} cache ${cache} object ${id}`).toEqual(
						sorted(expected)
					);
					compared++;
					if (expected.length) nonEmpty++;
				}
			}
		}
		// Guard against a vacuous pass on graphs where nothing is protected.
		expect(compared).toBeGreaterThan(1000);
		expect(nonEmpty).toBeGreaterThan(compared / 4);
	});

	it('returns nothing for a cache with no roots', async () => {
		const { sqlite, db, objectIds } = seedGraph(7);
		sqlite.exec('DELETE FROM gc_root WHERE cache_id = 1');
		for (const id of objectIds[1]) expect(await rootsProtecting(db, 1, id)).toEqual([]);
	});
});
