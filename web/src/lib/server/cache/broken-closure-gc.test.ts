import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabase, memoryBucket } from './test-db';
vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
import { runBrokenClosureGc } from './broken-closure-gc';
import { configureCache } from './cache-config';
import { clearUpstreamsMemo } from './missing-paths';
import { runGc } from './gc';
import { generateKeypair, extractPublicKey } from '../attic/signing';
import { buildNarInfo } from '../attic/narinfo';
import type { ExecutionContext } from './platform';

const hash = (n: number) => String(n).padStart(32, '0');
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	clearUpstreamsMemo();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});

function fixture(enabled = true) {
	const f = testDatabase();
	fixtures.push(f);
	const old = new Date(Date.now() - 30 * 86400_000).toISOString();
	f.sqlite
		.prepare(
			"INSERT INTO cache(id,name,keypair,created_at,purge_broken_after_days) VALUES(1,'one','k',?,?), (2,'two','k',?,NULL)"
		)
		.run(old, enabled ? 7 : null, old);
	f.sqlite
		.prepare(
			"INSERT INTO upstream(id,url,public_key,ttl,created_at) VALUES(1,'https://up.test','k',86400,?)"
		)
		.run(old);
	const object = (id: number, refs: number[], cache = 1, at = old) => {
		f.sqlite
			.prepare("INSERT INTO nar(id,state,nar_hash,nar_size,created_at) VALUES(?,'V',?,1,?)")
			.run(id, 'sha256:' + hash(id).repeat(2), at);
		f.sqlite
			.prepare(
				'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,refs,created_at) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				id,
				cache,
				id,
				hash(id),
				'/nix/store/' + hash(id) + '-path',
				JSON.stringify(refs.map((n) => hash(n) + '-path')),
				at
			);
	};
	object(1, [2, 5]);
	object(2, [3]);
	object(3, [99]);
	object(4, [1]);
	object(5, []);
	object(6, [5]);
	object(7, [99], 2);
	f.sqlite
		.prepare(
			'INSERT INTO object_ref VALUES(1,?,2),(1,?,5),(2,?,3),(3,?,NULL),(4,?,1),(6,?,5),(7,?,NULL)'
		)
		.run(hash(2), hash(5), hash(3), hash(99), hash(1), hash(5), hash(99));
	const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
	vi.stubGlobal('fetch', fetcher);
	const purge = vi.fn().mockResolvedValue(undefined);
	const ctx = { exports: { CachedStore: { purgeTags: purge } } } as unknown as ExecutionContext;
	const env = {
		ATTIC_DB: f.db,
		CACHE_BUCKET: memoryBucket().bucket
	} as unknown as App.Platform['env'];
	const ids = () =>
		f.sqlite
			.prepare('SELECT id FROM object WHERE cache_id=1 ORDER BY id')
			.all()
			.map((r) => r.id);
	const observe = () => runBrokenClosureGc(env, ctx);
	const age = () =>
		f.sqlite
			.prepare('UPDATE broken_reference SET first_missing_at=?')
			.run(new Date(Date.now() - 8 * 86400_000).toISOString());
	return { ...f, object, old, fetcher, purge, ctx, env, ids, observe, age };
}

describe('automatic broken closure maintenance', () => {
	it('is disabled by default and does no writes or probes', async () => {
		const f = fixture(false),
			before = f.totalChanges();
		expect((await f.observe()).automatic_objects_removed).toBe(0);
		expect(f.totalChanges()).toBe(before);
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it('starts a new clock for old uploads, confirms again after the delay, and preserves healthy/other-cache objects', async () => {
		const f = fixture();
		const first = await f.observe();
		expect(first.automatic_refs_waiting).toBe(1);
		expect(first.automatic_objects_removed).toBe(0);
		const clock = f.sqlite.prepare('SELECT * FROM broken_reference').get()!;
		expect(Date.parse(String(clock.first_missing_at))).toBeGreaterThan(Date.now() - 10_000);
		expect((await f.observe()).automatic_objects_removed).toBe(0);
		f.age();
		expect((await f.observe()).automatic_objects_removed).toBe(4);
		expect(f.ids()).toEqual([5, 6]);
		expect(f.sqlite.prepare('SELECT cache_id FROM object WHERE id=7').get()!.cache_id).toBe(2);
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM nar').get()!.n).toBe(7);
		expect(f.purge).toHaveBeenCalled();
	});
	it.each(['pin', 'new upload'])('keeps the entire closure protected by a %s', async (kind) => {
		const f = fixture();
		await f.observe();
		f.age();
		if (kind === 'pin')
			f.sqlite
				.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
				.run(hash(4), f.old);
		else
			f.sqlite
				.prepare('UPDATE object SET created_at=? WHERE id=4')
				.run(new Date(Date.now() - 86400_000).toISOString());
		expect((await f.observe()).automatic_objects_removed).toBe(0);
		expect(f.ids()).toEqual([1, 2, 3, 4, 5, 6]);
	});
	it.each([200, 503])(
		'resets the confirmation clock on recovery or uncertainty (HTTP %s)',
		async (status) => {
			const f = fixture();
			const key = await generateKeypair('test-upstream');
			f.sqlite.prepare('UPDATE upstream SET public_key=?').run(extractPublicKey(key));
			await f.observe();
			f.age();
			const recovered = await buildNarInfo(
				{
					store_path: '/nix/store/' + hash(99) + '-path',
					refs: '[]',
					sigs: '[]',
					system: null,
					deriver: null,
					ca: null
				},
				{ nar_hash: 'sha256:' + 'b'.repeat(64), nar_size: 1, compression: 'zstd' },
				[],
				key
			);
			f.fetcher.mockImplementation(
				async () => new Response(status === 200 ? recovered : null, { status })
			);
			expect((await f.observe()).automatic_objects_removed).toBe(0);
			expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_reference').get()!.n).toBe(0);
			f.sqlite.exec('DELETE FROM upstream_check');
			f.fetcher.mockResolvedValue(new Response(null, { status: 404 }));
			const again = await f.observe();
			expect(again.automatic_refs_waiting).toBe(1);
			expect(again.automatic_objects_removed).toBe(0);
		}
	);
	it('resets on a repaired local dependency and forgets references no remaining object needs', async () => {
		const f = fixture();
		await f.observe();
		f.age();
		f.object(99, []);
		expect((await f.observe()).automatic_objects_removed).toBe(0);
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_reference').get()!.n).toBe(0);
		f.sqlite.exec('DELETE FROM object WHERE id=99');
		await f.observe();
		f.sqlite.prepare('DELETE FROM object_ref WHERE ref_hash=?').run(hash(99));
		f.sqlite.exec(
			'DELETE FROM object_ref WHERE object_id IN(1,2,3,4); DELETE FROM object WHERE id IN(1,2,3,4)'
		);
		await f.observe();
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_reference').get()!.n).toBe(0);
	});
	it('resets on changed upstream configuration and on disabling/re-enabling policy', async () => {
		const f = fixture();
		await f.observe();
		f.age();
		f.sqlite.exec('UPDATE upstream SET ttl=90000');
		expect((await f.observe()).automatic_objects_removed).toBe(0);
		expect(
			Date.parse(
				String(f.sqlite.prepare('SELECT first_missing_at AS t FROM broken_reference').get()!.t)
			)
		).toBeGreaterThan(Date.now() - 10000);
		f.age();
		await configureCache(f.env, 'one', { purge_broken_after_days: null });
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_reference').get()!.n).toBe(0);
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_purge_state').get()!.n).toBe(0);
		await configureCache(f.env, 'one', { purge_broken_after_days: 7 });
		expect((await f.observe()).automatic_objects_removed).toBe(0);
	});
	it.each([
		'disable',
		'policy change',
		'upstream change',
		'new pin',
		'new parent',
		'recovered dependency',
		'revival'
	])('revalidates atomically after a concurrent %s', async (change) => {
		const f = fixture();
		await f.observe();
		f.age();
		const batch = f.db.batch.bind(f.db);
		vi.spyOn(f.db, 'batch').mockImplementation(async (statements) => {
			if (statements.length === 5) {
				if (change === 'disable')
					f.sqlite.exec('UPDATE cache SET purge_broken_after_days=NULL WHERE id=1');
				if (change === 'policy change')
					f.sqlite.exec('UPDATE cache SET purge_broken_after_days=30 WHERE id=1');
				if (change === 'upstream change') f.sqlite.exec("UPDATE upstream SET public_key='changed'");
				if (change === 'new pin')
					f.sqlite
						.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
						.run(hash(4), f.old);
				if (change === 'new parent') f.object(8, [4]);
				if (change === 'recovered dependency') f.object(99, []);
				if (change === 'revival')
					f.sqlite
						.prepare('UPDATE object SET created_at=? WHERE id=4')
						.run(new Date().toISOString());
			}
			return batch(statements);
		});
		expect((await f.observe()).automatic_objects_removed).toBe(0);
		expect(f.ids()).toContain(4);
	});
	it('bounds oversized deletions without cutting a closure in half', async () => {
		const f = fixture();
		for (let id = 1000; id < 1600; id++) f.object(id, [4]);
		await f.observe();
		f.age();
		const result = await f.observe();
		expect(result.automatic_objects_removed).toBe(0);
		expect(result.automatic_purge_deferred).toBe(1);
		expect(f.ids()).toHaveLength(606);
	});
	it('converges across runs when 32 disjoint dependency groups exceed the combined plan cap', async () => {
		const f = fixture();
		f.sqlite.exec('DELETE FROM object_ref; DELETE FROM object; DELETE FROM nar');
		for (let group = 0; group < 32; group++) {
			for (let offset = 0; offset < 100; offset++) {
				const id = 1000 + group * 100 + offset;
				f.object(id, [9000 + group]);
				f.sqlite.prepare('INSERT INTO object_ref VALUES(?,?,NULL)').run(id, hash(9000 + group));
			}
		}
		await f.observe();
		f.age();
		for (let run = 0; run < 8; run++) {
			const result = await f.observe();
			expect(result.automatic_purge_errors).toBe(0);
			expect(result.automatic_objects_removed).toBe(400);
			expect(f.ids()).toHaveLength(3200 - (run + 1) * 400);
		}
	});
	it('advances past oversized dependencies and wraps without starving actionable ones', async () => {
		const f = fixture();
		f.sqlite.exec('DELETE FROM object_ref; DELETE FROM object; DELETE FROM nar');
		for (let group = 0; group < 5; group++) {
			const size = group === 4 ? 100 : 501;
			for (let offset = 0; offset < size; offset++) {
				const id = 1000 + group * 501 + offset;
				f.object(id, [9000 + group]);
				f.sqlite.prepare('INSERT INTO object_ref VALUES(?,?,NULL)').run(id, hash(9000 + group));
			}
		}
		await f.observe();
		f.age();
		const first = await f.observe();
		expect(first.automatic_objects_removed).toBe(0);
		expect(first.automatic_purge_deferred).toBe(5);
		expect(
			f.sqlite.prepare('SELECT purge_after_hash FROM broken_purge_state').get()!.purge_after_hash
		).toBe(hash(9003));
		expect((await f.observe()).automatic_objects_removed).toBe(100);
		expect(f.ids()).toHaveLength(4 * 501);
		expect(
			f.sqlite.prepare('SELECT purge_after_hash FROM broken_purge_state').get()!.purge_after_hash
		).toBe(hash(9002));
	});
	it('advances discovery while rechecking existing observations, with bounded live probes', async () => {
		const f = fixture();
		for (let id = 10; id < 210; id++) {
			f.object(id, [9000 + id]);
			f.sqlite.prepare('INSERT INTO object_ref VALUES(?,?,NULL)').run(id, hash(9000 + id));
		}
		await f.observe();
		const before = String(
			f.sqlite.prepare('SELECT after_hash FROM broken_purge_state').get()!.after_hash
		);
		f.fetcher.mockClear();
		const next = await f.observe();
		expect(next.automatic_refs_checked).toBeLessThanOrEqual(64);
		expect(f.fetcher.mock.calls.length).toBeLessThanOrEqual(200);
		expect(
			String(f.sqlite.prepare('SELECT after_hash FROM broken_purge_state').get()!.after_hash) >
				before
		).toBe(true);
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_reference').get()!.n).toBeGreaterThan(
			32
		);
	});
	it('round-robins caches instead of spending the whole invocation on a backlog', async () => {
		const f = fixture();
		f.sqlite.exec('UPDATE cache SET purge_broken_after_days=7 WHERE id=2');
		await f.observe();
		await f.observe();
		expect(
			f.sqlite
				.prepare('SELECT cache_id FROM broken_purge_state ORDER BY cache_id')
				.all()
				.map((r) => r.cache_id)
		).toEqual([1, 2]);
	});
	it('does not run automatic purge during manual or dry-run GC', async () => {
		const f = fixture();
		await runGc(f.env, { ctx: f.ctx, integrityReport: false });
		await runGc(f.env, {
			ctx: f.ctx,
			integrityReport: false,
			dryRun: true,
			automaticBrokenPurge: true
		});
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broken_purge_state').get()!.n).toBe(0);
		expect(f.ids()).toEqual([1, 2, 3, 4, 5, 6]);
	});
	it('runs inside scheduled GC and persists the resulting cleanup counts', async () => {
		const f = fixture();
		await runGc(f.env, { ctx: f.ctx, integrityReport: false, automaticBrokenPurge: true });
		f.age();
		const stats = await runGc(f.env, {
			ctx: f.ctx,
			integrityReport: false,
			automaticBrokenPurge: true
		});
		expect(stats.automatic_objects_removed).toBe(4);
		expect(f.ids()).toEqual([5, 6]);
		const saved = JSON.parse(
			String(
				f.sqlite.prepare("SELECT value FROM server_config WHERE key='gc_last_run'").get()!.value
			)
		);
		expect(saved.stats.automatic_objects_removed).toBe(4);
	});
	it.each([0, -1, 0.5, 3651, '7', NaN])('rejects invalid policy %s', async (value) => {
		const f = fixture(false);
		await expect(
			configureCache(f.env, 'one', { purge_broken_after_days: value as number })
		).rejects.toThrow('purge_broken_after_days');
	});
});
