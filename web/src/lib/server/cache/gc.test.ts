import { afterEach, expect, it, vi } from 'vitest';
import { memoryBucket, testDatabase } from './test-db';
vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
import { continueScheduledGc, runGc, queueGc, readGcOperation } from './gc';
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

it('checkpoints integrity probes and bounded report pages without repeating completed scans', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
	const f = fixture(600);
	f.sqlite.exec('UPDATE cache SET retention_period=NULL');
	// Real Nix reference hashes are 32 characters; use the same missing edge for every parent.
	f.sqlite
		.prepare('UPDATE object SET refs=?')
		.run(JSON.stringify(['z'.repeat(32) + '-dependency']));
	const prepare = f.db.prepare.bind(f.db);
	let probes = 0;
	const pages: number[] = [];
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes('SELECT r.ref_hash AS h') || sql.includes('AS incomplete')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const result = await all<T>();
				if (sql.includes('AS incomplete')) pages.push(result.results.length);
				else probes++;
				if (result.results.length) result.meta.duration = 1_100;
				return result;
			};
		}
		return stmt;
	});
	const analyze = vi.spyOn(f.db, 'exec');
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job()).toMatchObject({ phase: 7, integrityWork: { probed: true, after: 256 } });
	expect(pages).toEqual([256]);
	for (let i = 0; f.job() && i < 10; i++) {
		vi.advanceTimersByTime(60_000);
		await continueScheduledGc(f.env);
	}
	expect(f.job()).toBeNull();
	expect(probes).toBe(0);
	expect(pages).toEqual([256, 256, 88, 0]);
	const summary = JSON.parse(
		String(f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()!.value)
	);
	expect(summary.integrity.incompleteObjects).toBe(600);
	expect(summary.integrity.examples).toHaveLength(20);
	expect(summary.integrity.examples[0]).toContain('00000000000000000000000000000001');
	expect(analyze).toHaveBeenCalledWith('ANALYZE');
});

it('skips abandoned-cache deletion scans when no cache is eligible', async () => {
	const f = fixture();
	const prepare = f.db.prepare.bind(f.db);
	const queries: string[] = [];
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		queries.push(sql);
		return prepare(sql);
	});
	await runGc(f.env, { integrityReport: false });
	expect(queries.some((q) => q.startsWith('DELETE FROM object WHERE cache_id IN'))).toBe(false);
});

it('resumes bounded broken-closure discovery past covered windows on the same cache', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
	const f = fixture(1026);
	f.sqlite.exec('UPDATE cache SET retention_period=NULL,purge_broken_after_days=7');
	const missing = 'z'.repeat(32) + '-missing';
	const refs = Array.from({ length: 1025 }, (_, i) => String(i + 2).padStart(32, '0') + '-fixture');
	f.sqlite.prepare('UPDATE object SET refs=? WHERE id=1').run(JSON.stringify([...refs, missing]));
	const prepare = f.db.prepare.bind(f.db);
	const windows: number[] = [];
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes('SELECT ref_hash FROM object_ref WHERE ref_hash > ?1')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				const result = await all<T>();
				windows.push(result.results.length);
				result.meta.duration = 1_100;
				return result;
			};
		}
		return stmt;
	});
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job()).toMatchObject({ phase: 6, brokenCacheId: 1 });
	const after = f.sqlite
		.prepare('SELECT after_hash FROM broken_purge_state WHERE cache_id=1')
		.get()!.after_hash;
	expect(after).toBe(String(513).padStart(32, '0'));
	// A second enabled cache must not steal the continuation after last_run_at changed.
	f.sqlite
		.prepare(
			"INSERT INTO cache(id,name,keypair,purge_broken_after_days,created_at) VALUES(2,'second','k',7,?)"
		)
		.run(new Date().toISOString());
	for (let i = 0; f.job() && i < 10; i++) {
		vi.advanceTimersByTime(60_000);
		await continueScheduledGc(f.env);
	}
	expect(f.job()).toBeNull();
	expect(windows).toEqual([513, 513, 2]);
	expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_purge_state').get()!.n).toBe(1);
	expect(f.sqlite.prepare('SELECT ref_hash FROM broken_reference').get()!.ref_hash).toBe(
		'z'.repeat(32)
	);
	const summary = JSON.parse(
		String(f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()!.value)
	);
	expect(summary.stats).toMatchObject({
		automatic_refs_checked: 1,
		automatic_purge_errors: 0,
		automatic_objects_removed: 0
	});
});

it('rotates bounded integrity probes across nights without starving later hashes', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
	const f = fixture();
	f.sqlite.exec('UPDATE cache SET retention_period=NULL');
	const hashes = Array.from({ length: 600 }, (_, i) => String(i + 10).padStart(32, '0'));
	f.sqlite.prepare('UPDATE object SET refs=?').run(JSON.stringify(hashes.map((h) => h + '-dep')));
	f.sqlite
		.prepare(
			"INSERT INTO upstream(id,url,public_key,ttl,created_at) VALUES(1,'https://up.test','k',86400,?)"
		)
		.run(new Date().toISOString());
	for (const h of hashes)
		f.sqlite.prepare('INSERT INTO upstream_check VALUES(1,?,0,?)').run(h, new Date().toISOString());
	const prepare = f.db.prepare.bind(f.db);
	let queries = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes('SELECT r.ref_hash AS h')) {
			expect(sql).toContain('r.ref_hash <= ?2');
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				queries++;
				const r = await all<T>();
				r.meta.duration = 1100;
				return r;
			};
		}
		return stmt;
	});
	const totals: number[] = [];
	for (let night = 0; night < 3; night++) {
		await continueScheduledGc(f.env, undefined, true);
		for (let i = 0; f.job() && i < 20; i++) {
			vi.advanceTimersByTime(60_000);
			await continueScheduledGc(f.env);
		}
		expect(f.job()).toBeNull();
		const summary = JSON.parse(
			String(
				f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()!.value
			)
		);
		totals.push(summary.stats.integrity_refs_probed);
	}
	expect(totals).toEqual([250, 250, 100]);
	expect(queries).toBe(3);
	expect(
		f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_integrity_probe_after'").get()!
			.value
	).toBe('');
});

it('defers a repeatedly resource-limited integrity phase and still reaches ANALYZE', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
	const f = fixture();
	f.sqlite.exec('UPDATE cache SET retention_period=NULL');
	f.sqlite.prepare("INSERT INTO server_config VALUES('gc_last_run',?)").run(
		JSON.stringify({
			at: '2026-11-16',
			stats: {},
			integrity: { incompleteObjects: 9, examples: ['previous-warning'] }
		})
	);
	const prepare = f.db.prepare.bind(f.db);
	let failures = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes('AS incomplete'))
			stmt.all = vi.fn(async () => {
				failures++;
				throw new Error(
					'D1 DB is overloaded. Too many resources consumed within a 10 second window'
				);
			});
		return stmt;
	});
	const analyze = vi.spyOn(f.db, 'exec');
	for (let i = 0; i < 3; i++) {
		const running = continueScheduledGc(f.env, undefined, i === 0);
		await vi.advanceTimersByTimeAsync(15_000);
		await running;
		if (i < 2) expect(f.job().phase).toBe(7);
		vi.advanceTimersByTime(60_000);
	}
	expect(f.job().phase).toBe(8);
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
	expect(failures).toBe(3);
	expect(analyze).toHaveBeenCalledWith('ANALYZE');
	const summary = JSON.parse(
		String(f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()!.value)
	);
	expect(summary.stats.advisory_phases_deferred).toBe(1);
	expect(summary.integrity).toMatchObject({
		incompleteObjects: 9,
		deferred: true,
		examples: ['previous-warning']
	});
});

it('keeps committed purge progress and stops retrying a later resource-limited plan', async () => {
	// SQLite's one-hour confirmation guard uses its real clock. Start the
	// fake JS clock at the same time, rather than a date that will expire.
	vi.useFakeTimers();
	const f = fixture(4);
	f.sqlite.exec('UPDATE cache SET retention_period=NULL,purge_broken_after_days=7');
	for (let id = 1; id <= 4; id++)
		f.sqlite
			.prepare('UPDATE object SET refs=? WHERE id=?')
			.run(JSON.stringify([String(100 + id).padStart(32, '0') + '-missing']), id);
	await continueScheduledGc(f.env, undefined, true);
	expect(f.job()).toBeNull();
	f.sqlite
		.prepare('UPDATE broken_reference SET first_missing_at=?')
		.run(new Date(Date.now() - 8 * 86400_000).toISOString());
	const prepare = f.db.prepare.bind(f.db);
	let plans = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes('AS blocked')) {
			const all = stmt.all.bind(stmt);
			stmt.all = async <T>() => {
				plans++;
				if (plans > 1)
					throw new Error(
						'D1 DB is overloaded. Too many resources consumed within a 10 second window'
					);
				const result = await all<T>();
				result.meta.duration = 1100;
				return result;
			};
		}
		return stmt;
	});
	const analyze = vi.spyOn(f.db, 'exec');
	for (let i = 0; i < 4; i++) {
		const running = continueScheduledGc(f.env, undefined, i === 0);
		await vi.advanceTimersByTimeAsync(15_000);
		await running;
		if (i === 0) {
			expect(f.job().brokenWork.pending).toMatchObject({
				plans: 1,
				stats: { automatic_objects_removed: 1 }
			});
			expect(f.count('object')).toBe(3);
		}
		if (i > 0)
			expect(
				f.sqlite.prepare('SELECT purge_after_hash FROM broken_purge_state WHERE cache_id=1').get()!
					.purge_after_hash
			).toBe(String(101 + i).padStart(32, '0'));
		vi.advanceTimersByTime(60_000);
	}
	expect(f.job().phase).toBe(7);
	await continueScheduledGc(f.env);
	expect(f.job()).toBeNull();
	expect(plans).toBe(4);
	expect(f.count('object')).toBe(3);
	const summary = JSON.parse(
		String(f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()!.value)
	);
	expect(summary.stats).toMatchObject({
		automatic_objects_removed: 1,
		advisory_phases_deferred: 1,
		automatic_purge_deferred: 3
	});
	expect(analyze).toHaveBeenCalledWith('ANALYZE');
});

it('queues one resumable instance-wide operation and persists its completion', async () => {
	const f = fixture();
	const queued = await queueGc(f.env);
	expect(queued).toMatchObject({ state: 'pending', dryRun: false });
	expect(f.count('object')).toBe(1);
	expect((await queueGc(f.env, true)).id).toBe(queued.id);
	await continueScheduledGc(f.env);
	expect(await readGcOperation(f.db)).toMatchObject({
		id: queued.id,
		state: 'complete',
		dryRun: false
	});
	expect(f.count('object')).toBe(0);
});
it('a queued preview survives refresh and completes without deleting paths or replacing GC history', async () => {
	const f = fixture();
	const queued = await queueGc(f.env, true);
	expect(await readGcOperation(f.db)).toEqual(queued);
	await continueScheduledGc(f.env);
	expect(await readGcOperation(f.db)).toMatchObject({
		state: 'complete',
		dryRun: true,
		stats: { expired_objects_reaped: 1 }
	});
	expect(f.count('object')).toBe(1);
	expect(
		f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()
	).toBeUndefined();
});

it.each([false, true])(
	'bounds bootstrap throttling without modifying durable state (queued=%s)',
	async (queued) => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const f = fixture();
		if (queued) await queueGc(f.env, true);
		const prior = f.job(),
			before = f.totalChanges(),
			prepare = f.db.prepare.bind(f.db);
		const reads = vi
			.fn()
			.mockRejectedValue(
				new Error(
					'D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.'
				)
			);
		const spy = vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
			const stmt = prepare(sql);
			if (sql.includes("WHERE key='gc_job'")) stmt.all = reads;
			return stmt;
		});
		const pending = continueScheduledGc(f.env);
		await vi.advanceTimersByTimeAsync(9999);
		expect(reads).toHaveBeenCalledTimes(1);
		expect(f.totalChanges()).toBe(before);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toBeUndefined();
		expect(reads).toHaveBeenCalledTimes(2);
		expect(f.totalChanges()).toBe(before);
		expect(f.job()).toEqual(prior);
		expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
			expect.objectContaining({
				event: 'nimbus.gc.deferred',
				stage: 'bootstrap',
				reason: 'resources'
			})
		);
		spy.mockRestore();
		await vi.advanceTimersByTimeAsync(60000);
		await continueScheduledGc(f.env);
		expect(f.job()).toBeNull();
		expect(f.count('object')).toBe(1);
	}
);
it('retries a throttled nightly checkpoint after the resource window and still starts maintenance', async () => {
	vi.useFakeTimers();
	vi.spyOn(Math, 'random').mockReturnValue(0);
	const f = fixture();
	const prepare = f.db.prepare.bind(f.db);
	let reads = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes("WHERE key='gc_job'") && ++reads === 1)
			stmt.all = vi
				.fn()
				.mockRejectedValue(
					new Error(
						'D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.'
					)
				);
		return stmt;
	});
	const pending = continueScheduledGc(f.env, undefined, true);
	await vi.advanceTimersByTimeAsync(10000);
	await pending;
	expect(f.job()).toBeNull();
	expect(f.count('object')).toBe(0);
	expect(await readGcOperation(f.db)).toMatchObject({ state: 'complete' });
});
it('preserves the existing checkpoint and releases its lock if reloading after acquisition is throttled', async () => {
	vi.useFakeTimers();
	vi.spyOn(Math, 'random').mockReturnValue(0);
	const f = fixture();
	await queueGc(f.env, true);
	const prior = f.job(),
		prepare = f.db.prepare.bind(f.db);
	let reads = 0;
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = prepare(sql);
		if (sql.includes("WHERE key='gc_job'") && ++reads === 2)
			stmt.all = vi
				.fn()
				.mockRejectedValue(
					new Error(
						'D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.'
					)
				);
		return stmt;
	});
	const pending = continueScheduledGc(f.env);
	await vi.advanceTimersByTimeAsync(15000);
	await pending;
	expect(f.job()).toEqual(prior);
	expect(
		f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_lock'").get()
	).toBeUndefined();
});
