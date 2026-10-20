import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { testDatabase, loseBatchResponses } from './test-db';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
import { applyPurge, processPathPurge, purgePlan, replayPathPurges } from './closure-purge';
import { checkReferences } from './closure-repair';
import { clearUpstreamsMemo, type Upstream } from './missing-paths';
import { handleCacheApi } from './router';
import type { ExecutionContext } from './platform';
import { createObject } from './db';

const hash = (n: number) => String(n).padStart(32, '0');
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	clearUpstreamsMemo();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});
function fixture() {
	const f = testDatabase();
	fixtures.push(f);
	const old = new Date(Date.now() - 7 * 86400_000).toISOString();
	f.sqlite
		.exec(`INSERT INTO cache(id,name,keypair,created_at) VALUES(1,'one','k','${old}'),(2,'two','k','${old}');
      INSERT INTO upstream(id,url,public_key,ttl,created_at) VALUES(1,'https://up.test','k',86400,'${old}');`);
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
	// Root 4 was uploaded after GC's graph sync. Plans must still find it.
	f.sqlite
		.prepare('INSERT INTO object_ref VALUES(1,?,2),(2,?,3),(3,?,NULL)')
		.run(hash(2), hash(3), hash(99));
	f.sqlite
		.prepare('INSERT INTO upstream_check VALUES(1,?,0,?)')
		.run(hash(99), new Date().toISOString());
	const purge = vi.fn().mockResolvedValue(undefined);
	const ctx = { exports: { CachedStore: { purgeTags: purge } } } as unknown as ExecutionContext;
	const env = { ATTIC_DB: f.db } as App.Platform['env'];
	const ids = () =>
		f.sqlite
			.prepare('SELECT id FROM object WHERE cache_id=1 ORDER BY id')
			.all()
			.map((r) => r.id);
	return { ...f, object, env, ctx, purge, ids, old };
}
const operation = '00000000-0000-0000-0000-000000000001';

describe('purge plans and application', () => {
	it('plans all reverse dependents without writes, including unsynced objects; preserves healthy shared dependencies and other caches', async () => {
		const f = fixture();
		const before = f.totalChanges();
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		expect(plan.objects.map((o) => o.id)).toEqual([1, 2, 3, 4]);
		expect(f.totalChanges()).toBe(before);
		const result = await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation);
		expect(result).toEqual({ removed: 4, pending_purge: false });
		expect(f.ids()).toEqual([5, 6]);
		expect(f.sqlite.prepare('SELECT cache_id FROM object WHERE id=7').get()!.cache_id).toBe(2);
		expect(
			f.sqlite
				.prepare(
					'SELECT COUNT(*) AS n FROM object_ref WHERE object_id IN (1,2,3,4) OR child_id IN (1,2,3,4)'
				)
				.get()!.n
		).toBe(0);
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM nar').get()!.n).toBe(7);
		expect(f.purge).toHaveBeenCalled();
	});

	it.each(['pin', 'recent upload'])('keeps a closure protected by a %s', async (kind) => {
		const f = fixture();
		if (kind === 'pin')
			f.sqlite
				.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
				.run(hash(4), f.old);
		else
			f.sqlite.prepare('UPDATE object SET created_at=? WHERE id=4').run(new Date().toISOString());
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		expect(plan.objects.map((o) => o.blocked)).toEqual([1, 1, 1, 1]);
		const result = await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation);
		expect(result.removed).toBe(0);
		expect(f.ids()).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it.each([
		'recovered dependency',
		'unverified upstream',
		'repushed object',
		'new parent',
		'new pin'
	])('revalidates a reviewed plan after a %s', async (change) => {
		const f = fixture();
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		if (change === 'recovered dependency') f.object(99, []);
		if (change === 'unverified upstream') f.sqlite.exec('DELETE FROM upstream_check');
		if (change === 'repushed object') {
			f.sqlite
				.prepare(
					"INSERT INTO nar(id,state,nar_hash,nar_size,created_at) VALUES(44,'V','replacement',1,?)"
				)
				.run(f.old);
			f.sqlite.exec('UPDATE object SET nar_id=44 WHERE id=4');
		}
		if (change === 'new parent') f.object(8, [4]);
		if (change === 'new pin') {
			const batch = f.db.batch.bind(f.db);
			vi.spyOn(f.db, 'batch').mockImplementationOnce(async (stmts) => {
				// Arrives after the handler's reads, immediately before the atomic batch.
				f.sqlite
					.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
					.run(hash(4), f.old);
				return batch(stmts);
			});
		}
		const result = await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation);
		expect(result.removed).toBe(0);
		expect(f.ids()).toEqual(
			change === 'recovered dependency'
				? [1, 2, 3, 4, 5, 6, 99]
				: change === 'new parent'
					? [1, 2, 3, 4, 5, 6, 8]
					: [1, 2, 3, 4, 5, 6]
		);
	});

	it('does not expand an approved subset and handles cycles as a unit', async () => {
		const f = fixture();
		f.sqlite
			.prepare('UPDATE object SET refs=? WHERE id=2')
			.run(JSON.stringify([hash(3) + '-path', hash(1) + '-path']));
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		const subset = plan.objects.filter((o) => o.id !== 4);
		expect((await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], subset, operation)).removed).toBe(
			0
		);
		expect(
			(
				await applyPurge(
					f.env,
					f.ctx,
					1,
					'one',
					[hash(99)],
					plan.objects,
					operation.replace(/1$/, '2')
				)
			).removed
		).toBe(4);
	});

	it('retains a detached path revived after planning even when its NAR is unchanged', async () => {
		const f = fixture();
		f.sqlite.prepare('UPDATE object SET detached_at=? WHERE id=4').run(f.old);
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		f.sqlite.exec('UPDATE object SET detached_at=NULL WHERE id=4');
		expect(
			(await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation)).removed
		).toBe(0);
	});

	it('starts the push grace period when an old detached path is revived before planning', async () => {
		const f = fixture();
		f.sqlite.prepare('UPDATE object SET detached_at=? WHERE id=4').run(f.old);
		const upload = {
			cache_id: 1,
			nar_id: 4,
			store_path_hash: hash(4),
			store_path: '/nix/store/' + hash(4) + '-path',
			references: [hash(1) + '-path'],
			system: null,
			deriver: null,
			sigs: [],
			ca: null,
			source: 'push',
			created_by: null
		};
		await createObject(f.db, upload);
		const revived = f.sqlite.prepare('SELECT created_at,detached_at FROM object WHERE id=4').get()!;
		expect(revived.detached_at).toBeNull();
		expect(Date.parse(String(revived.created_at))).toBeGreaterThan(Date.now() - 10_000);
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		expect(plan.objects.map((o) => o.blocked)).toEqual([1, 1, 1, 1]);
		expect(
			(await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation)).removed
		).toBe(0);
		// Already attached uploads must not perpetually renew grace/retention or
		// incur another object/index write for an idempotent re-publication.
		const before = f.totalChanges();
		await createObject(f.db, upload);
		expect(f.totalChanges()).toBe(before);
		expect(f.sqlite.prepare('SELECT created_at FROM object WHERE id=4').get()!.created_at).toBe(
			revived.created_at
		);
	});

	it.each([false, true])(
		'plans and applies a 10,000-object chain with indexed traversals (ANALYZE=%s)',
		async (analyzed) => {
			const f = fixture();
			f.sqlite.exec(
				'DELETE FROM object_ref; DELETE FROM object; DELETE FROM nar; DELETE FROM upstream_check; BEGIN'
			);
			const size = 10_000;
			for (let id = 1; id <= size; id++) f.object(id, [id + 1]);
			const edge = f.sqlite.prepare('INSERT INTO object_ref VALUES(?,?,?)');
			for (let id = 1; id <= size; id++) edge.run(id, hash(id + 1), id < size ? id + 1 : null);
			f.sqlite
				.prepare('INSERT INTO upstream_check VALUES(1,?,0,?)')
				.run(hash(size + 1), new Date().toISOString());
			f.sqlite.exec('COMMIT');
			if (analyzed) f.sqlite.exec('ANALYZE');
			const targets = f.sqlite
				.prepare(
					'SELECT id,store_path_hash,store_path,nar_id,created_at,detached_at,0 AS blocked FROM object ORDER BY id'
				)
				.all() as unknown as Awaited<ReturnType<typeof purgePlan>>['objects'];
			const prepared = vi.spyOn(f.db, 'prepare');
			const start = performance.now();
			const plan = await purgePlan(f.db, 1, [hash(size + 1)]);
			expect(plan.objects).toHaveLength(500);
			expect(plan.next_cursor).toBe(500);
			const bindings = {
				1: 1,
				2: JSON.stringify([hash(size + 1)]),
				3: JSON.stringify(targets),
				4: new Date(Date.now() - 6 * 3600_000).toISOString()
			};
			// Inspect eligibility with an approval list too, without first running
			// a quadratic mutation. This must work even before statistics exist.
			const ctes = prepared.mock.calls[0][0].split('\n SELECT o.id,')[0];
			const queryPlan = f.sqlite
				.prepare('EXPLAIN QUERY PLAN ' + ctes + 'SELECT id FROM eligible')
				.all({ 1: bindings[1], 2: bindings[2], 3: bindings[3], 4: bindings[4] })
				.map((row) => String(row.detail));
			expect(queryPlan.some((line) => /^SCAN e$/.test(line))).toBe(false);
			expect(
				queryPlan.filter((line) => /SEARCH e USING AUTOMATIC.*INDEX \(child=\?\)/.test(line))
			).toHaveLength(2);
			expect(queryPlan).toContain(
				'SEARCH child USING COVERING INDEX sqlite_autoindex_object_1 (cache_id=? AND store_path_hash=?)'
			);
			const scanApproval = queryPlan.indexOf('SCAN p VIRTUAL TABLE INDEX 1:');
			expect(scanApproval).toBeGreaterThan(-1);
			expect(queryPlan[scanApproval + 1]).toBe('SEARCH o USING INTEGER PRIMARY KEY (rowid=?)');
			// Exercise the forward protection walk across the entire chain.
			f.sqlite
				.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
				.run(hash(1), f.old);
			expect(
				(await purgePlan(f.db, 1, [hash(size + 1)])).objects.every((o) => o.blocked === 1)
			).toBe(true);
			expect(
				(await applyPurge(f.env, f.ctx, 1, 'one', [hash(size + 1)], targets, operation)).removed
			).toBe(0);
			f.sqlite.exec('DELETE FROM gc_root');
			expect(
				(
					await applyPurge(
						f.env,
						f.ctx,
						1,
						'one',
						[hash(size + 1)],
						targets,
						operation.replace(/1$/, '2')
					)
				).removed
			).toBe(size);
			expect(f.ids()).toEqual([]);
			expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM object_ref').get()!.n).toBe(0);
			console.info(
				`10,000-object purge (ANALYZE=${analyzed}): ${Math.round(performance.now() - start)}ms`
			);
		},
		10_000
	);

	it('bounds edge-invalidation pages and resumes a persisted cursor', async () => {
		const f = fixture();
		const objects = Array.from({ length: 300 }, (_, i) => ({
			hash: hash(i + 1000),
			nar_hash: 'nar-' + i
		}));
		f.sqlite
			.prepare(
				"INSERT INTO path_purge (id,cache_id,cache_name,objects,created_at,state) VALUES(?,1,'one',?,?,'deleted')"
			)
			.run(operation, JSON.stringify(objects), f.old);
		const receipts: string[] = [];
		const purge = vi.fn(async (tags: string[], receipt: string) => {
			expect(tags.length).toBeLessThanOrEqual(100);
			receipts.push(receipt);
			return true;
		});
		expect(await processPathPurge(f.env, operation, purge)).toBeTypeOf('number');
		expect(f.sqlite.prepare('SELECT tag_cursor FROM path_purge').get()!.tag_cursor).toBe(1000);
		expect(purge).toHaveBeenCalledTimes(10);
		expect(await processPathPurge(f.env, operation, purge)).toBeNull();
		expect(receipts.at(10)).toBe('1000');
		expect(purge).toHaveBeenCalledTimes(12);
	});

	it('survives a lost committed response and keeps a durable journal until edge eviction succeeds', async () => {
		const f = fixture();
		const plan = await purgePlan(f.db, 1, [hash(99)]);
		loseBatchResponses(f.db, (call) => call === 1);
		f.purge.mockRejectedValue(new Error('edge unavailable'));
		expect(await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation)).toEqual({
			removed: 4,
			pending_purge: true
		});
		expect(f.sqlite.prepare('SELECT state FROM path_purge').get()!.state).toBe('deleted');
		f.purge.mockResolvedValue(undefined);
		expect(await replayPathPurges(f.env, f.ctx)).toEqual({ pending: 0 });
		expect(await applyPurge(f.env, f.ctx, 1, 'one', [hash(99)], plan.objects, operation)).toEqual({
			removed: 4,
			pending_purge: false
		});
		expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM path_purge').get()!.n).toBe(1);
	});
});

it('strict checks retain unanswered upstream probes and accept an unpersistable but serveable upstream', async () => {
	const f = fixture();
	f.sqlite.exec('DELETE FROM upstream_check');
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => new Response(null, { status: url.includes(hash(99)) ? 503 : 404 }))
	);
	const upstream = {
		id: 1,
		url: 'https://up.test',
		publicKey: null,
		ttl: 86400,
		mode: 'persist',
		persistInto: 'one',
		nixDefault: false
	} as Upstream;
	expect(await checkReferences(f.db, 'one', [upstream], [hash(98), hash(99)])).toEqual({
		missing: [hash(98)],
		unverified: [hash(99)]
	});
	f.sqlite
		.prepare('INSERT INTO upstream_check VALUES(1,?,2,?)')
		.run(hash(99), new Date().toISOString());
	expect(await checkReferences(f.db, 'one', [upstream], [hash(99)])).toEqual({
		missing: [],
		unverified: []
	});
});

it('destructive checks re-probe a cached miss and retain recovered or uncertain upstream paths', async () => {
	const f = fixture();
	const upstream = {
		id: 1,
		url: 'https://up.test',
		publicKey: null,
		ttl: 86400,
		mode: 'redirect',
		persistInto: null,
		nixDefault: false
	} as Upstream;
	const fetch = vi.fn(async () => new Response(null, { status: 503 }));
	vi.stubGlobal('fetch', fetch);
	expect(await checkReferences(f.db, 'one', [upstream], [hash(99)], undefined, true)).toEqual({
		missing: [],
		unverified: [hash(99)]
	});
	expect(fetch).toHaveBeenCalledOnce();
	fetch.mockResolvedValue(new Response(null, { status: 200 }));
	expect(await checkReferences(f.db, 'one', [upstream], [hash(99)], undefined, true)).toEqual({
		missing: [],
		unverified: []
	});
});

it('requires pull and delete for purge, validates inputs, and permits a delete-only writer to inspect the graph', async () => {
	const f = fixture();
	const key = new TextEncoder().encode('purge-test');
	const env = {
		...f.env,
		JWT_HS256_SECRET_BASE64: Buffer.from(key).toString('base64')
	} as App.Platform['env'];
	const call = async (bits: Record<string, number>, suffix: string, body: unknown) => {
		const token = await new SignJWT({ 'https://jwt.attic.rs/v1': { caches: { one: bits } } })
			.setProtectedHeader({ alg: 'HS256' })
			.setExpirationTime('1h')
			.sign(key);
		return handleCacheApi(
			new Request('https://cache.test/_api/v1/cache-integrity/one' + suffix, {
				method: body === undefined ? 'GET' : 'POST',
				headers: { Authorization: 'Bearer ' + token },
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			env,
			f.ctx
		);
	};
	expect((await call({ r: 1, w: 1 }, '/purge-plan', { hashes: [hash(99)] })).status).toBe(403);
	expect((await call({ d: 1 }, '/purge-plan', { hashes: [hash(99)] })).status).toBe(403);
	expect((await call({ r: 1, d: 1 }, '', undefined)).status).toBe(200);
	expect((await call({ r: 1, d: 1 }, '/purge-plan', { hashes: ['bad'] })).status).toBe(400);
	const plan = await call({ r: 1, d: 1 }, '/purge-plan', { hashes: [hash(99)] });
	expect(plan.status).toBe(200);
	expect(((await plan.json()) as { objects: unknown[] }).objects).toHaveLength(4);
	expect(
		(
			await call({ r: 1, d: 1 }, '/purge-apply', {
				id: operation,
				hashes: [hash(99)],
				targets: [{ id: -1 }]
			})
		).status
	).toBe(400);
});
