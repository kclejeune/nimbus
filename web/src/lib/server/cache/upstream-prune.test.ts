import { afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from './test-db';
vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
import { pruneUpstreamChecks } from './gc';
import { PARAM_BATCH } from './db';
import { GcDeferred, GcPacer, gcCheckpoint, pacedGcDatabase } from './gc-pacing';

type Progress = NonNullable<Parameters<typeof pruneUpstreamChecks>[1]>;
const fixtures: ReturnType<typeof testDatabase>[] = [];
const hash = (i: number) => String(i).padStart(32, '0');
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});
function fixture() {
	const f = testDatabase();
	fixtures.push(f);
	f.sqlite.exec(`INSERT INTO upstream(id,url,public_key,ttl,created_at) VALUES
		(1,'https://one.test','key',86400,'2026-01-01'),
		(2,'https://two.test','key',86400,'2026-01-01')`);
	const insert = f.sqlite.prepare('INSERT INTO upstream_check VALUES(?,?,?,?)');
	const expired = new Date(Date.now() - 3 * 86400_000).toISOString();
	return {
		...f,
		seed(i: number, stale = true, upstream = 1) {
			insert.run(upstream, hash(i), 0, stale ? expired : new Date().toISOString());
		},
		count: () => Number(f.sqlite.prepare('SELECT COUNT(*) AS n FROM upstream_check').get()!.n)
	};
}

/** Keep real SQL, including plans and mutations; model D1's indexed-write accounting. */
function observe(
	f: ReturnType<typeof fixture>,
	beforeDelete?: () => void,
	afterDelete?: () => void
) {
	const prepare = f.db.prepare.bind(f.db);
	const scanned: number[] = [],
		deleted: number[] = [],
		plans: string[] = [];
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		let values: (number | string)[] = [];
		const bind = stmt.bind.bind(stmt);
		stmt.bind = (...args) => {
			values = args as (number | string)[];
			return bind(...args);
		};
		if (sql.includes('AS expired') || sql.startsWith('DELETE FROM upstream_check')) {
			const plan = () => {
				const params = Object.fromEntries(values.map((v, i) => [String(i + 1), v]));
				const rows = f.sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(params);
				plans.push(String(rows.find((r) => String(r.detail).includes('upstream_check'))?.detail));
			};
			if (sql.includes('AS expired')) {
				const all = stmt.all.bind(stmt);
				stmt.all = async <T>() => {
					plan();
					const result = await all<T>();
					scanned.push(result.results.length);
					return result;
				};
			} else {
				const run = stmt.run.bind(stmt);
				stmt.run = async <T>() => {
					plan();
					beforeDelete?.();
					const result = await run<T>();
					deleted.push(result.meta.changes);
					result.meta.rows_written = result.meta.changes * 3;
					afterDelete?.();
					return result;
				};
			}
		}
		return stmt;
	});
	return { scanned, deleted, plans };
}

it.each([false, true])(
	'scans covered windows once and bounds indexed deletes (analyzed=%s)',
	async (analyzed) => {
		const f = fixture();
		for (let i = 0; i < 720; i++) f.seed(i, i >= 600);
		f.seed(0, true, 2);
		if (analyzed) f.sqlite.exec('ANALYZE');
		const observations = observe(f);
		const progress: Progress = {};
		await pruneUpstreamChecks(f.db, progress);
		expect(f.count()).toBe(600);
		expect(progress.upstreamPrune).toBeUndefined();
		expect(observations.scanned.reduce((n, v) => n + v, 0)).toBe(721);
		expect(Math.max(...observations.scanned)).toBeLessThanOrEqual(256);
		expect(Math.max(...observations.deleted)).toBeLessThanOrEqual(
			Math.floor((PARAM_BATCH - 3) / 2)
		);
		expect(
			observations.plans.every((p) =>
				p.startsWith('SEARCH upstream_check USING INDEX sqlite_autoindex_upstream_check_1')
			)
		).toBe(true);
	}
);

it('rechecks refreshed verdicts and changed upstream TTLs at deletion time', async () => {
	const f = fixture();
	f.seed(0);
	f.sqlite
		.prepare('INSERT INTO upstream_check VALUES(2,?,1,?)')
		.run(hash(1), new Date(Date.now() - 100 * 86400_000).toISOString());
	const before = vi.fn(() => {
		f.sqlite
			.prepare('UPDATE upstream_check SET checked_at=? WHERE upstream_id=1')
			.run(new Date().toISOString());
		f.sqlite.exec('UPDATE upstream SET ttl=31536000 WHERE id=2');
	});
	observe(f, before);
	await pruneUpstreamChecks(f.db);
	expect(before).toHaveBeenCalledOnce();
	expect(f.count()).toBe(2);
});

it('removes verdicts for deleted registry entries', async () => {
	const f = fixture();
	f.seed(0, false);
	f.sqlite.exec('PRAGMA foreign_keys=OFF; DELETE FROM upstream WHERE id=1');
	await pruneUpstreamChecks(f.db);
	expect(f.count()).toBe(0);
});

it('resumes a saved cursor after committed chunks without revisiting the earlier prefix', async () => {
	const f = fixture();
	for (let i = 0; i < 600; i++) f.seed(i);
	const observations = observe(f);
	const progress: Progress = {};
	const paused = new GcDeferred(Date.now(), 'budget', ['writes']);
	await expect(
		pruneUpstreamChecks(f.db, progress, async () => {
			if (progress.upstreamPrune?.after) throw paused;
		})
	).rejects.toBe(paused);
	const end = Math.floor((PARAM_BATCH - 3) / 2);
	expect(progress.upstreamPrune!.after).toEqual({ upstream_id: 1, store_path_hash: hash(end - 1) });
	expect(f.count()).toBe(600 - end);
	const resumed: Progress = JSON.parse(JSON.stringify(progress));
	await pruneUpstreamChecks(f.db, resumed);
	expect(f.count()).toBe(0);
	expect(resumed.upstreamPrune).toBeUndefined();
	expect(observations.scanned[1]).toBe(256);
});

it('safely replays a committed deletion with a lost response and preserves reinserted fresh rows', async () => {
	const f = fixture();
	for (let i = 0; i < 100; i++) f.seed(i);
	let lose = true;
	observe(f, undefined, () => {
		if (lose) {
			lose = false;
			throw new Error('response lost');
		}
	});
	const progress: Progress = {};
	await expect(pruneUpstreamChecks(f.db, progress)).rejects.toThrow('response lost');
	expect(progress.upstreamPrune!.after).toBeUndefined();
	f.seed(0, false);
	await pruneUpstreamChecks(f.db, progress);
	expect(f.count()).toBe(1);
	expect(
		f.sqlite.prepare('SELECT store_path_hash FROM upstream_check').get()!.store_path_hash
	).toBe(hash(0));
});

it('keeps a fixed upper key so newly appended verdicts do not extend this sweep', async () => {
	const f = fixture();
	for (let i = 0; i < 20; i++) f.seed(i);
	const progress: Progress = {};
	let inserted = false;
	await pruneUpstreamChecks(f.db, progress, async () => {
		if (!inserted) {
			inserted = true;
			f.seed(1000);
		}
	});
	expect(f.count()).toBe(1);
	await pruneUpstreamChecks(f.db);
	expect(f.count()).toBe(0);
});

it('yields between committed delete batches on write pressure, then finishes with a fresh pacer', async () => {
	const f = fixture();
	for (let i = 0; i < 600; i++) f.seed(i);
	observe(f);
	const progress: Progress = {};
	const p = new GcPacer(true);
	const db = pacedGcDatabase(f.db, p);
	await expect(
		pruneUpstreamChecks(db, progress, async () => gcCheckpoint(db))
	).rejects.toMatchObject({ reason: 'budget', budgets: ['writes'] });
	expect(f.count()).toBeGreaterThan(0);
	expect(f.count()).toBeLessThan(600);
	const next = pacedGcDatabase(f.db, new GcPacer(true));
	await pruneUpstreamChecks(next, progress, async () => gcCheckpoint(next));
	expect(f.count()).toBe(0);
});
