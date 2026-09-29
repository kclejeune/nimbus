import { describe, expect, it } from 'vitest';
import { testDatabase } from './test-db';
import { ingestBaseline, ingestSeries } from './ingest';

/** One cache; `nars` maps a NAR id to its chunks' stored sizes. */
function seed(objects: { day: string; nar: number }[], nars: Record<number, number[]>) {
	const { sqlite, db } = testDatabase();
	sqlite.exec(
		`INSERT INTO cache (id, name, keypair, created_at) VALUES (1, 'main', 'k', '2026-01-01')`
	);
	let chunkId = 0;
	for (const [narId, sizes] of Object.entries(nars)) {
		sqlite
			.prepare(
				`INSERT INTO nar (id, state, nar_hash, nar_size, num_chunks, created_at)
				 VALUES (?, 'V', ?, 0, ?, '2026-01-01')`
			)
			.run(Number(narId), `h${narId}`, sizes.length);
		sizes.forEach((size, seq) => {
			chunkId++;
			sqlite
				.prepare(
					`INSERT INTO chunk (id, state, chunk_hash, chunk_size, file_size, remote_file, remote_file_id, created_at)
					 VALUES (?, 'V', ?, ?, ?, '{}', ?, '2026-01-01')`
				)
				.run(chunkId, `c${chunkId}`, size, size, `r${chunkId}`);
			sqlite
				.prepare(`INSERT INTO chunkref (nar_id, seq, chunk_id, chunk_hash) VALUES (?, ?, ?, ?)`)
				.run(Number(narId), seq, chunkId, `c${chunkId}`);
		});
	}
	objects.forEach((o, i) =>
		sqlite
			.prepare(
				`INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, created_at)
				 VALUES (1, ?, ?, ?, ?)`
			)
			.run(o.nar, `p${i}`, `/nix/store/p${i}`, `${o.day}T12:00:00Z`)
	);
	return db;
}

describe('ingestSeries', () => {
	it('counts a chunked NAR as one path, not one per chunk', async () => {
		// NAR 1 is a big NAR cut into 5 chunks; NAR 2 is a single chunk.
		const db = seed(
			[
				{ day: '2026-03-02', nar: 1 },
				{ day: '2026-03-02', nar: 2 }
			],
			{ 1: [10, 20, 30, 40, 50], 2: [7] }
		);
		expect(await ingestSeries(db, 'day', null)).toEqual([
			{ bucket: '2026-03-02', paths: 2, bytes: 157 }
		]);
	});

	it('counts each path sharing a NAR, with its bytes', async () => {
		const db = seed(
			[
				{ day: '2026-03-02', nar: 1 },
				{ day: '2026-03-03', nar: 1 }
			],
			{ 1: [5, 5] }
		);
		expect(await ingestSeries(db, 'week', null)).toEqual([
			{ bucket: '2026-03-02', paths: 2, bytes: 20 }
		]);
	});

	it('filters by start date and computes the baseline before it', async () => {
		const db = seed(
			[
				{ day: '2026-02-10', nar: 1 },
				{ day: '2026-03-05', nar: 2 }
			],
			{ 1: [1, 2, 3], 2: [4] }
		);
		expect(await ingestSeries(db, 'month', '2026-03-01')).toEqual([
			{ bucket: '2026-03-01', paths: 1, bytes: 4 }
		]);
		expect(await ingestBaseline(db, '2026-03-01')).toEqual({ paths: 1, bytes: 6 });
	});
});
