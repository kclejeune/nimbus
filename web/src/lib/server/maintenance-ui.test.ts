import { afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from './cache/test-db';
import {
	startClosureCheck,
	stepClosureCheck,
	pauseClosureCheck,
	readClosureCheck,
	readMaintenanceResult,
	saveMaintenanceResult
} from './maintenance-ui';
import { inspectClosures } from './cache/closure-maintenance';
import * as inspections from './cache/closure-maintenance';
vi.mock('./cache/compression', async () => (await import('./cache/test-db')).fakeCompression());
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});
const hash = (n: number) => String(n).padStart(32, '0');
function fixture() {
	const f = testDatabase();
	fixtures.push(f);
	f.sqlite.exec(
		"INSERT INTO cache(id,name,keypair,created_at) VALUES(1,'one','k','2026-01-01'),(2,'two','k','2026-01-01'),(3,'gone','k','2026-01-01'); UPDATE cache SET deleted_at='2026-01-02' WHERE id=3;"
	);
	f.sqlite.exec(
		"INSERT INTO nar(id,state,nar_hash,nar_size,created_at) VALUES(1,'V','nar',1,'2026-01-01')"
	);
	f.sqlite
		.prepare(
			'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,refs,created_at) VALUES(1,1,1,?,?,?,?)'
		)
		.run(
			hash(1),
			'/nix/store/' + hash(1) + '-path',
			JSON.stringify([hash(999) + '-missing']),
			'2026-01-01'
		);
	f.sqlite.prepare('INSERT INTO object_ref(object_id,ref_hash) VALUES(1,?)').run(hash(999));
	const env = {
		ATTIC_DB: f.db,
		SESSION_SECRET: 'test-maintenance-secret-at-least-32-characters'
	} as App.Platform['env'];
	return { ...f, env };
}
it('checks all live caches in resumable batches, with no removal plan or deletions', async () => {
	const f = fixture();
	const check = await startClosureCheck(f.env, 'admin', '*');
	expect(check.caches.map((c) => c.name)).toEqual(['one', 'two']);
	const first = await stepClosureCheck(f.env, 'admin', check.id, null);
	expect(first).toMatchObject({
		state: 'running',
		index: 1,
		caches: [{ state: 'complete', missing: 1, firstFinding: '' }, { state: 'queued' }]
	});
	expect(await readClosureCheck(f.db, 'admin')).toEqual(first);
	const done = await stepClosureCheck(f.env, 'admin', check.id, null);
	expect(done.state).toBe('complete');
	expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM object').get()!.n).toBe(1);
	expect(await readClosureCheck(f.db, 'other-admin')).toBeNull();
});
it('scopes a check to one cache and rejects replaced progress or unavailable caches', async () => {
	const f = fixture();
	const old = await startClosureCheck(f.env, 'admin', '*');
	const single = await startClosureCheck(f.env, 'admin', 'two');
	expect(single.caches.map((c) => c.name)).toEqual(['two']);
	await expect(stepClosureCheck(f.env, 'admin', old.id, null)).rejects.toThrow('replaced');
	await expect(startClosureCheck(f.env, 'admin', 'gone')).rejects.toThrow('No caches');
});
it('returns an active lease to another tab, and preserves a pause during an in-flight batch', async () => {
	const f = fixture();
	const check = await startClosureCheck(f.env, 'admin', 'one');
	let resume!: () => void, entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const release = new Promise<void>((r) => {
		resume = r;
	});
	const original = inspections.inspectClosures;
	vi.spyOn(inspections, 'inspectClosures').mockImplementation(async (...args) => {
		entered();
		await release;
		return original(...args);
	});
	const promise = stepClosureCheck(f.env, 'admin', check.id, null);
	await started;
	const current = await readClosureCheck(f.db, 'admin');
	expect(current?.leaseUntil).toBeGreaterThan(Date.now());
	expect((await stepClosureCheck(f.env, 'admin', check.id, null)).lease).toBe(current!.lease);
	await pauseClosureCheck(f.db, 'admin', check.id);
	resume();
	expect((await promise).state).toBe('paused');
});
it('restores removal receipts after refresh even if the action lost its response', async () => {
	const f = fixture();
	const preview = await inspectClosures(f.env, 'admin', 'one');
	await saveMaintenanceResult(f.db, 'admin', { preview, removing: true });
	f.sqlite
		.prepare(
			"INSERT INTO path_purge(id,cache_id,cache_name,objects,removed,state,created_at) VALUES(?,1,'one','[]',3,'deleted','2026-01-01')"
		)
		.run(preview.inspection.operationId);
	expect(await readMaintenanceResult(f.env, 'admin')).toMatchObject({
		removing: false,
		purge: { removed: 3, pending_purge: true }
	});
	f.sqlite.prepare("UPDATE path_purge SET state='done'").run();
	expect(await readMaintenanceResult(f.env, 'admin')).toMatchObject({
		purge: { pending_purge: false }
	});
	expect(await readMaintenanceResult(f.env, 'other-admin')).toBeNull();
});
it('marks an expired preview after refresh rather than presenting it as a completed removal', async () => {
	const f = fixture();
	const preview = await inspectClosures(f.env, 'admin', 'one');
	await saveMaintenanceResult(f.db, 'admin', { preview });
	vi.useFakeTimers();
	vi.setSystemTime(Date.now() + 16 * 60_000);
	expect(await readMaintenanceResult(f.env, 'admin')).toMatchObject({
		expired: true,
		message: expect.stringContaining('expired')
	});
});
