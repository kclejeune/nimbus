import { describe, expect, it } from 'vitest';
import { testDatabase } from './test-db';
import { ingestBaseline, ingestSeries, refreshIngestRollup } from './ingest';

/** One cache; `nars` maps a NAR id to its chunks' stored sizes. */
function seed(objects: { day: string; nar: number }[], nars: Record<number, number[]>) {
	return seedWithSql(objects, nars).db;
}

function seedWithSql(objects: { day: string; nar: number }[], nars: Record<number, number[]>) {
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
	return { sqlite, db };
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

describe('ingest rollup', () => {
	// Pushes across two months, a chunked NAR and a shared one.
	const objects = [
		{ day: '2026-02-10', nar: 1 },
		{ day: '2026-02-24', nar: 2 },
		{ day: '2026-03-02', nar: 1 },
		{ day: '2026-03-05', nar: 3 },
		{ day: '2026-03-09', nar: 2 },
		{ day: '2026-03-12', nar: 3 }
	];
	const nars = { 1: [10, 20, 30], 2: [7], 3: [4, 4] };

	async function views(db: ReturnType<typeof seed>) {
		const out: unknown[] = [];
		for (const g of ['day', 'week', 'month'] as const) {
			for (const since of [null, '2026-02-24', '2026-03-05', '2026-04-01']) {
				out.push(await ingestSeries(db, g, since));
			}
		}
		for (const before of ['2026-01-01', '2026-02-24', '2026-03-06', '2026-04-01']) {
			out.push(await ingestBaseline(db, before));
		}
		return out;
	}

	it('gives the same series and baselines as the live walk, wherever the bound falls', async () => {
		const expected = await views(seed(objects, nars));
		// Rolled up before, inside, and after the pushes (a stale rollup, a
		// partial one, and one covering everything).
		for (const now of ['2026-01-15', '2026-03-05', '2026-03-06', '2026-06-01']) {
			const db = seed(objects, nars);
			await refreshIngestRollup(db, new Date(`${now}T08:00:00Z`));
			expect(await views(db), `rolled up at ${now}`).toEqual(expected);
		}
	});

	it('reads the rollup before its bound and the live walk from it on', async () => {
		const { sqlite, db } = seedWithSql(objects, nars);
		await refreshIngestRollup(db, new Date('2026-03-06T08:00:00Z'));
		// Mark the rollup's rows, and plant one past the bound: the marked rows
		// must surface, the planted one must not.
		sqlite.exec('UPDATE ingest_day SET bytes = bytes + 1000');
		sqlite.exec("INSERT INTO ingest_day (day, paths, bytes) VALUES ('2026-03-09', 99, 99)");
		expect(await ingestSeries(db, 'day', null)).toEqual([
			{ bucket: '2026-02-10', paths: 1, bytes: 1060 },
			{ bucket: '2026-02-24', paths: 1, bytes: 1007 },
			{ bucket: '2026-03-02', paths: 1, bytes: 1060 },
			{ bucket: '2026-03-05', paths: 1, bytes: 1008 },
			{ bucket: '2026-03-09', paths: 1, bytes: 7 },
			{ bucket: '2026-03-12', paths: 1, bytes: 8 }
		]);
	});
});
