import { afterEach, expect, it, vi } from 'vitest';
import { memoryBucket, testDatabase } from './test-db';
vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
import { continueScheduledGc, runGc } from './gc';
import { clearUpstreamsMemo } from './missing-paths';

const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	clearUpstreamsMemo();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});
function fixture(objects = 1) {
	const f = testDatabase({ admin: true });
	fixtures.push(f);
	const old = new Date(Date.now() - 30 * 86400_000).toISOString();
	f.sqlite
		.prepare(
			"INSERT INTO cache(id,name,keypair,retention_period,created_at) VALUES(1,'fixture','unused',1,?)"
		)
		.run(old);
	f.sqlite
		.prepare("INSERT INTO nar(id,state,nar_hash,nar_size,created_at) VALUES(1,'V','nar',1,?)")
		.run(old);
	for (let i = 1; i <= objects; i++)
		f.sqlite
			.prepare(
				'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,created_at) VALUES(?,1,1,?,?,?)'
			)
			.run(
				i,
				String(i).padStart(32, '0'),
				'/nix/store/' + String(i).padStart(32, '0') + '-fixture',
				old
			);
	const env = {
		ATTIC_DB: f.db,
		CACHE_BUCKET: memoryBucket().bucket
	} as unknown as App.Platform['env'];
	const job = () => {
		const r = f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_job'").get();
		return r ? JSON.parse(String(r.value)) : null;
	};
	const count = (table: string) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
	return { ...f, env, job, count };
}

it('an idle continuation only reads its checkpoint and never starts maintenance', async () => {
	const f = fixture();
	const before = f.totalChanges();
	await continueScheduledGc(f.env);
	expect(f.totalChanges()).toBe(before);
	expect(f.count('object')).toBe(1);
});

it('persists reference windows and resumes without replaying completed sync', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture(120);
	const batch = f.db.batch.bind(f.db);
	const spy = vi.spyOn(f.db, 'batch').mockImplementation(async (stmts) => {
		const rows = await batch(stmts);
		rows[0].meta.duration = 1_100;
		return rows;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job().phase).toBe(0);
	expect(
		Number(
			f.sqlite.prepare("SELECT value FROM server_config WHERE key='ref_sync_watermark'").get()!
				.value
		)
	).toBe(50);
	spy.mockRestore();
	vi.advanceTimersByTime(60_000);
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
	expect(f.count('object')).toBe(0);
	expect(
		f.sqlite.prepare("SELECT value FROM server_config WHERE key='ref_sync_watermark'").get()!.value
	).toBe('120');
});

it('retains committed deletion receipts when a later phase fails and resumes that phase', async () => {
	const f = fixture();
	const prepare = f.db.prepare.bind(f.db);
	const spy = vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes("key = 'global_max_bytes'"))
			stmt.all = vi.fn().mockRejectedValue(new Error('interrupted fixture'));
		return stmt;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job().phase).toBe(5);
	expect(f.count('object')).toBe(0);
	const receipt = f.sqlite.prepare("SELECT * FROM path_purge WHERE state='deleted'").get()!;
	expect(JSON.parse(String(receipt.objects))).toMatchObject([
		{ id: 1, hash: '00000000000000000000000000000001', nar_hash: 'nar' }
	]);
	spy.mockRestore();
	f.sqlite.exec("UPDATE server_config SET value=json_set(value,'$.nextAt',0) WHERE key='gc_job'");
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
	expect(f.count('path_purge')).toBe(1);
});

it('rolls back the purge receipt if metadata deletion fails', async () => {
	const f = fixture();
	f.sqlite.exec(
		"CREATE TRIGGER fail_gc BEFORE DELETE ON object BEGIN SELECT RAISE(ABORT,'fixture failure'); END;"
	);
	await runGc(f.env, { integrityReport: false });
	expect(f.count('object')).toBe(1);
	expect(f.count('path_purge')).toBe(0);
});

it('backs off resource-window overload without issuing short retries', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture();
	const batch = vi
		.spyOn(f.db, 'batch')
		.mockRejectedValue(
			new Error('D1 DB is overloaded. Too many resources consumed within a 10 second window')
		);
	const pending = continueScheduledGc(f.env, undefined, true);
	await vi.advanceTimersByTimeAsync(15_000);
	await pending;
	expect(batch).toHaveBeenCalledOnce();
	expect(f.job().phase).toBe(0);
	expect(f.job().nextAt).toBeGreaterThanOrEqual(new Date('2026-11-06T12:00:10Z').getTime());
	expect(
		f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_lock'").get()
	).toBeUndefined();
	batch.mockRestore();
	vi.advanceTimersByTime(60_000);
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
});

it('does not delete a re-pushed object when a committed deletion response is lost', async () => {
	const f = fixture();
	const original = f.db.batch.bind(f.db);
	let lost = false;
	vi.spyOn(f.db, 'batch').mockImplementation(async (stmts) => {
		const rows = await original(stmts);
		if (!lost && f.count('object') === 0 && f.count('path_purge') === 1) {
			lost = true;
			f.sqlite
				.prepare(
					'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,created_at) VALUES(1,1,1,?,?,?)'
				)
				.run(
					'00000000000000000000000000000001',
					'/nix/store/00000000000000000000000000000001-fixture',
					new Date().toISOString()
				);
			throw new Error('D1_ERROR: Network connection lost.');
		}
		return rows;
	});
	await runGc(f.env, { integrityReport: false });
	expect(lost).toBe(true);
	expect(f.count('object')).toBe(1);
	expect(f.count('path_purge')).toBe(1);
	expect(f.sqlite.prepare('SELECT removed FROM path_purge').get()!.removed).toBe(1);
});

it('counts detached objects rather than the number of their purge tags', async () => {
	const f = fixture();
	f.sqlite.exec("UPDATE object SET detached_at='2026-01-01'");
	const stats = await runGc(f.env, { integrityReport: false });
	expect(stats.detached_objects_reaped).toBe(1);
	expect(f.count('object')).toBe(0);
});

it('checkpoints a completed cache before yielding and skips its graph on resume', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture();
	// A second cache with no expired paths needs no deletion work.
	f.sqlite
		.prepare(
			"INSERT INTO cache(id,name,keypair,retention_period,created_at) VALUES(2,'second','k',1,?)"
		)
		.run(new Date().toISOString());
	const prepare = f.db.prepare.bind(f.db);
	const spy = vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.startsWith('WITH RECURSIVE keep(id)') && sql.includes('o.id > ?3')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const r = await all<T>();
				r.meta.duration = 1_100;
				return r;
			};
		}
		return stmt;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job()).toMatchObject({ phase: 4, cacheAfter: 1 });
	spy.mockRestore();
	vi.advanceTimersByTime(60_000);
	const queries: string[] = [];
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		queries.push(sql);
		return prepare(sql);
	});
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
	// Only the second cache's retention query runs, with no repeat of detached work.
	expect(queries.filter((q) => q.startsWith('WITH RECURSIVE keep(id)'))).toHaveLength(1);
});

it.each([false, true])(
	'refreshes intervening uploads before resumed deletion (detached=%s)',
	async (detached) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
		const f = fixture();
		if (detached) f.sqlite.exec("UPDATE object SET detached_at='2026-01-01'");
		const batch = f.db.batch.bind(f.db);
		const slow = vi.spyOn(f.db, 'batch').mockImplementation(async (stmts) => {
			const results = await batch(stmts);
			results[0].meta.duration = 1_100;
			return results;
		});
		await continueScheduledGc(f.env, undefined, true);
		expect(f.job().phase).toBe(1);
		slow.mockRestore();
		const dependency = '00000000000000000000000000000001';
		f.sqlite
			.prepare(
				'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,refs,created_at) VALUES(2,1,1,?,?,?,?)'
			)
			.run(
				'00000000000000000000000000000002',
				'/nix/store/00000000000000000000000000000002-parent',
				JSON.stringify([dependency + '-fixture']),
				new Date().toISOString()
			);
		vi.advanceTimersByTime(60_000);
		await continueScheduledGc(f.env);
		expect(f.job()).toBeNull();
		expect(f.count('object')).toBe(2);
		expect(
			f.sqlite.prepare('SELECT child_id FROM object_ref WHERE object_id=2').get()!.child_id
		).toBe(1);
		expect(f.count('path_purge')).toBe(0);
	}
);

it('checkpoints 200 expensive roots across slices and eventually runs ANALYZE', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture(200);
	const old = new Date(Date.now() - 86400_000).toISOString();
	for (let i = 1; i <= 200; i++)
		f.sqlite
			.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
			.run(String(i).padStart(32, '0'), old);
	const prepare = f.db.prepare.bind(f.db);
	let computed = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.startsWith('WITH RECURSIVE cl(id)') && sql.includes('AS objects')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const r = await all<T>();
				computed++;
				r.meta.duration = 1_000;
				return r;
			};
		}
		return stmt;
	});
	const analyze = vi.spyOn(f.db, 'exec');
	await continueScheduledGc(f.env, undefined, true);
	expect(computed).toBe(1);
	expect(f.job().rootAfter).toBe(1);
	expect(vi.getTimerCount()).toBe(0);
	let slices = 1;
	while (f.job() && slices <= 205) {
		vi.advanceTimersByTime(60_000);
		await continueScheduledGc(f.env);
		expect(vi.getTimerCount()).toBe(0);
		slices++;
	}
	expect(f.job()).toBeNull();
	expect(computed).toBe(200);
	expect(
		f.sqlite.prepare('SELECT COUNT(*) AS n FROM gc_root WHERE stats_at IS NOT NULL').get()!.n
	).toBe(200);
	expect(analyze).toHaveBeenCalledWith('ANALYZE');
});

it('checkpoints roots on the slice deadline even when SQL accounting is cheap', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture(4);
	for (let i = 1; i <= 4; i++)
		f.sqlite
			.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
			.run(String(i).padStart(32, '0'), new Date().toISOString());
	const prepare = f.db.prepare.bind(f.db);
	let computed = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.startsWith('WITH RECURSIVE cl(id)') && sql.includes('AS objects')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const r = await all<T>();
				computed++;
				vi.advanceTimersByTime(7_000);
				return r;
			};
		}
		return stmt;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(computed).toBe(3);
	expect(f.job().rootAfter).toBe(3);
	expect(
		f.sqlite.prepare('SELECT COUNT(*) AS n FROM gc_root WHERE stats_at IS NOT NULL').get()!.n
	).toBe(3);
	vi.advanceTimersByTime(60_000);
	await continueScheduledGc(f.env);
	expect(computed).toBe(4);
	expect(f.job()).toBeNull();
});

it('checkpoints orphan preparation and bounded chunk batches without repeating their scans', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture(0);
	const insert = f.sqlite.prepare(
		"INSERT INTO chunk(id,state,chunk_hash,chunk_size,remote_file,remote_file_id,created_at) VALUES(?,'V',?,1,?,?,?)"
	);
	for (let i = 1; i <= 1001; i++)
		insert.run(
			i,
			'hash-' + i,
			JSON.stringify({ key: 'chunk-' + i }),
			'chunk-' + i,
			new Date(Date.now() - 86400_000).toISOString()
		);
	const prepare = f.db.prepare.bind(f.db);
	let preparations = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		const preparation = sql.startsWith('UPDATE chunk SET holders_count');
		if (preparation || sql.startsWith("DELETE FROM chunk WHERE state='D'")) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const r = await all<T>();
				if (preparation) preparations++;
				r.meta.duration = preparation ? 1100 : 100;
				return r;
			};
		}
		return stmt;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job().orphanPrepared).toBe(true);
	expect(f.count('chunk')).toBe(1001);
	vi.advanceTimersByTime(60_000);
	await continueScheduledGc(f.env);
	expect(f.job().chunkAfter).toBe(1000);
	expect(f.count('chunk')).toBe(1);
	vi.advanceTimersByTime(60_000);
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
	expect(f.count('chunk')).toBe(0);
	expect(preparations).toBe(1);
	expect(f.env.CACHE_BUCKET.delete).toHaveBeenCalledTimes(2);
});

it('makes progress after a slow graph query and refreshes new references before remaining deletions', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
	const f = fixture(120);
	const prepare = f.db.prepare.bind(f.db);
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.startsWith('WITH RECURSIVE keep(id)') && sql.includes('o.id > ?3')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const r = await all<T>();
				vi.advanceTimersByTime(21_000);
				return r;
			};
		}
		return stmt;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(f.count('object')).toBe(21);
	expect(f.count('path_purge')).toBe(1);
	f.sqlite
		.prepare(
			'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,refs,created_at) VALUES(121,1,1,?,?,?,?)'
		)
		.run(
			String(121).padStart(32, '0'),
			'/nix/store/' + String(121).padStart(32, '0') + '-parent',
			JSON.stringify([String(120).padStart(32, '0') + '-fixture']),
			new Date().toISOString()
		);
	let slices = 0;
	while (f.job() && slices++ < 5) {
		vi.advanceTimersByTime(60_000);
		await continueScheduledGc(f.env);
	}
	expect(f.job()).toBeNull();
	expect(f.sqlite.prepare('SELECT id FROM object ORDER BY id').all()).toEqual([
		{ id: 120 },
		{ id: 121 }
	]);
});

it.each(['cache', 'global'])(
	'makes size eviction progress when its %s preflight consumes the budget',
	async (scope) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
		const f = fixture(2);
		f.sqlite.exec('UPDATE cache SET retention_period=NULL');
		if (scope === 'cache') f.sqlite.exec('UPDATE cache SET retention_max_bytes=5');
		else f.sqlite.exec("INSERT INTO server_config(key,value) VALUES('global_max_bytes','5')");
		f.sqlite
			.prepare(
				"INSERT INTO chunk(id,state,chunk_hash,chunk_size,file_size,remote_file,remote_file_id,created_at) VALUES(1,'V','budget',10,10,'{\"key\":\"budget\"}','budget',?)"
			)
			.run(new Date(Date.now() - 86400_000).toISOString());
		f.sqlite.exec("INSERT INTO chunkref(nar_id,seq,chunk_id,chunk_hash) VALUES(1,0,1,'budget')");
		const prepare = f.db.prepare.bind(f.db);
		vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
			const stmt = prepare(sql);
			const expensive =
				scope === 'cache'
					? sql.includes('FROM (SELECT DISTINCT nar_id FROM object WHERE cache_id = ?1)')
					: sql === "SELECT COALESCE(SUM(file_size), 0) AS n FROM chunk WHERE state = 'V'";
			if (expensive) {
				const all = stmt.all.bind(stmt);
				stmt.all = async <T>() => {
					const r = await all<T>();
					r.meta.duration = 1_100;
					return r;
				};
			}
			return stmt;
		});
		await continueScheduledGc(f.env, undefined, true);
		expect(f.count('object')).toBe(1);
		let slices = 0;
		while (f.job() && slices++ < 10) {
			vi.advanceTimersByTime(60_000);
			await continueScheduledGc(f.env);
		}
		expect(f.job()).toBeNull();
		expect(f.count('object')).toBe(0);
	}
);
