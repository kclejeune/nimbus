import { afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from './test-db';
import { applyClosurePreview, inspectClosures, readClosurePreview } from './closure-maintenance';
import { clearUpstreamsMemo } from './missing-paths';
import type { ExecutionContext } from './platform';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

const hash = (n: number) => String(n).padStart(32, '0');
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	clearUpstreamsMemo();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});

function fixture(referenceCount = 1) {
	const f = testDatabase();
	fixtures.push(f);
	const old = new Date(Date.now() - 7 * 86400_000).toISOString();
	f.sqlite
		.prepare("INSERT INTO cache(id,name,keypair,created_at) VALUES(1,'one','k',?),(2,'two','k',?)")
		.run(old, old);
	const object = (id: number, refs: number[], cache = 1, created = old) => {
		f.sqlite
			.prepare("INSERT INTO nar(id,state,nar_hash,nar_size,created_at) VALUES(?,'V',?,1,?)")
			.run(id, 'sha256:' + hash(id).repeat(2), created);
		f.sqlite
			.prepare(
				'INSERT INTO object(id,cache_id,nar_id,store_path_hash,store_path,refs,created_at) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				id,
				cache,
				id,
				hash(id),
				`/nix/store/${hash(id)}-path`,
				JSON.stringify(refs.map((n) => `${hash(n)}-path`)),
				created
			);
	};
	const references = Array.from({ length: referenceCount }, (_, i) => 900 + i);
	object(1, references);
	object(2, [1]);
	object(3, [900]);
	object(4, [900], 1, new Date().toISOString());
	object(5, [900], 2);
	for (const n of references)
		f.sqlite
			.prepare('INSERT INTO object_ref(object_id,ref_hash,child_id) VALUES(?,?,NULL)')
			.run(1, hash(n));
	f.sqlite
		.prepare('INSERT INTO object_ref(object_id,ref_hash,child_id) VALUES(3,?,NULL)')
		.run(hash(900));
	f.sqlite
		.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
		.run(hash(3), old);
	const purgeTags = vi.fn(async () => {});
	const ctx = { exports: { CachedStore: { purgeTags } } } as unknown as ExecutionContext;
	const env = {
		ATTIC_DB: f.db,
		SESSION_SECRET: 'a-test-maintenance-secret-at-least-32-characters'
	} as App.Platform['env'];
	const ids = () =>
		f.sqlite
			.prepare('SELECT id FROM object ORDER BY id')
			.all()
			.map((r) => r.id);
	return { ...f, env, ctx, object, ids, old, purgeTags };
}

it('previews the same protected closure plan as the CLI without deleting anything', async () => {
	const f = fixture();
	const preview = await inspectClosures(f.env, 'admin-one', 'one');
	expect(preview.inspection.references).toMatchObject([{ hash: hash(900), status: 'missing' }]);
	expect(preview.inspection.objects.filter((o) => !o.blocked).map((o) => o.id)).toEqual([1, 2]);
	expect(preview.inspection.objects.filter((o) => o.blocked).map((o) => o.id)).toEqual([3, 4]);
	expect(f.ids()).toEqual([1, 2, 3, 4, 5]);
	expect(await readClosurePreview(f.env, 'admin-one', preview.token)).toEqual(preview.inspection);
});

it('applies only reviewed identities and keeps pins, recent uploads and other caches', async () => {
	const f = fixture();
	const preview = await inspectClosures(f.env, 'admin-one', 'one');
	const inspection = await readClosurePreview(f.env, 'admin-one', preview.token);
	const first = await applyClosurePreview(f.env, f.ctx, inspection);
	expect(first).toMatchObject({ removed: 2, pending_purge: false });
	expect(f.ids()).toEqual([3, 4, 5]);
	expect(await applyClosurePreview(f.env, f.ctx, inspection)).toEqual(first);
	expect(f.ids()).toEqual([3, 4, 5]);
	expect(f.purgeTags).toHaveBeenCalled();
});

it.each(['repair', 'pin', 'changed-object', 'new-dependent'])(
	'preserves paths affected by a concurrent %s after preview',
	async (change) => {
		const f = fixture();
		const { inspection } = await inspectClosures(f.env, 'admin-one', 'one');
		if (change === 'repair') f.object(900, []);
		if (change === 'pin')
			f.sqlite
				.prepare('INSERT INTO gc_root(cache_id,store_path_hash,created_at) VALUES(1,?,?)')
				.run(hash(2), f.old);
		if (change === 'changed-object')
			f.sqlite.prepare('UPDATE object SET created_at=? WHERE id=1').run(new Date().toISOString());
		if (change === 'new-dependent') f.object(6, [1]);
		await applyClosurePreview(f.env, f.ctx, inspection);
		expect(f.ids()).toContain(1);
		if (change === 'repair' || change === 'pin') expect(f.ids()).toContain(2);
		if (change === 'new-dependent') expect(f.ids()).toContain(6);
	}
);

it('does not treat unanswered upstream probes as confirmed missing', async () => {
	const f = fixture();
	f.sqlite
		.prepare(
			"INSERT INTO upstream(id,url,public_key,ttl,default_mode,created_at) VALUES(1,'https://upstream.test','test:key',3600,'redirect',?)"
		)
		.run(f.old);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(null, { status: 503 }))
	);
	const { inspection } = await inspectClosures(f.env, 'admin-one', 'one');
	expect(inspection.references).toMatchObject([{ status: 'unverified' }]);
	expect(inspection.objects).toEqual([]);
	await expect(applyClosurePreview(f.env, f.ctx, inspection)).rejects.toThrow('no removable');
	expect(f.ids()).toEqual([1, 2, 3, 4, 5]);
});

it('rejects changed previews and previews belonging to another admin', async () => {
	const f = fixture();
	const preview = await inspectClosures(f.env, 'admin-one', 'one');
	await expect(readClosurePreview(f.env, 'admin-two', preview.token)).rejects.toThrow(
		'expired or changed'
	);
	const parts = preview.token.split('.');
	const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
	payload.inspection.truncated = !payload.inspection.truncated;
	parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
	await expect(readClosurePreview(f.env, 'admin-one', parts.join('.'))).rejects.toThrow(
		'expired or changed'
	);
});

it('refuses apply when upstream coverage becomes uncertain after preview', async () => {
	const f = fixture();
	const { inspection } = await inspectClosures(f.env, 'admin-one', 'one');
	f.sqlite
		.prepare(
			"INSERT INTO upstream(id,url,public_key,ttl,default_mode,created_at) VALUES(1,'https://upstream.test','test:key',3600,'redirect',?)"
		)
		.run(f.old);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(null, { status: 503 }))
	);
	await expect(applyClosurePreview(f.env, f.ctx, inspection)).rejects.toThrow(
		'Nothing was removed'
	);
	expect(f.ids()).toEqual([1, 2, 3, 4, 5]);
	expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM path_purge').get()!.n).toBe(0);
});

it('rejects expired previews', async () => {
	const f = fixture();
	const preview = await inspectClosures(f.env, 'admin-one', 'one');
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + 16 * 60_000);
	await expect(readClosurePreview(f.env, 'admin-one', preview.token)).rejects.toThrow(
		'expired or changed'
	);
});

it('cannot apply a preview to a recreated cache', async () => {
	const f = fixture();
	const { inspection } = await inspectClosures(f.env, 'admin-one', 'one');
	f.sqlite.exec(
		"UPDATE cache SET name='old-one' WHERE id=1; INSERT INTO cache(id,name,keypair,created_at) VALUES(3,'one','k',datetime('now'))"
	);
	await expect(applyClosurePreview(f.env, f.ctx, inspection)).rejects.toThrow('cache was replaced');
	expect(f.ids()).toEqual([1, 2, 3, 4, 5]);
});

it('paginates dependency discovery instead of scanning the entire backlog', async () => {
	const f = fixture(26);
	const first = await inspectClosures(f.env, 'admin-one', 'one');
	expect(first.inspection.references).toHaveLength(25);
	expect(first.inspection.nextCursor).toBe(hash(924));
	const second = await inspectClosures(f.env, 'admin-one', 'one', first.inspection.nextCursor!);
	expect(second.inspection.references.map((r) => r.hash)).toEqual([hash(925)]);
	expect(second.inspection.nextCursor).toBeNull();
});

it('does not apply a truncated path preview', async () => {
	const f = fixture();
	for (let id = 10; id < 511; id++) f.object(id, [900]);
	const { inspection } = await inspectClosures(f.env, 'admin-one', 'one');
	expect(inspection.truncated).toBe(true);
	expect(inspection.objects).toHaveLength(500);
	await expect(applyClosurePreview(f.env, f.ctx, inspection)).rejects.toThrow('complete plan');
	expect(f.ids()).toHaveLength(506);
});

it('requires a new preview if upstream changes would exceed the probe bound', async () => {
	const f = fixture(25);
	const { inspection } = await inspectClosures(f.env, 'admin-one', 'one');
	for (let id = 1; id <= 5; id++)
		f.sqlite
			.prepare("INSERT INTO upstream(id,url,public_key,ttl,created_at) VALUES(?,?,'k',3600,?)")
			.run(id, `https://upstream${id}.test`, f.old);
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await expect(applyClosurePreview(f.env, f.ctx, inspection)).rejects.toThrow(
		'configuration changed'
	);
	expect(fetch).not.toHaveBeenCalled();
});

it.each([null, { id: 'member', role: 'member' }])(
	'requires an admin for both Settings maintenance actions (%j)',
	async (user) => {
		const { actions } = await import('../../../routes/(app)/settings/+page.server');
		const prepare = vi.fn();
		for (const action of ['inspectClosures', 'purgeClosures'] as const) {
			await expect(
				actions[action]!({
					locals: { user },
					platform: { env: { ATTIC_DB: { prepare } } },
					request: new Request('https://app.test/settings', { method: 'POST' })
				} as never)
			).rejects.toMatchObject({ status: user ? 403 : 401 });
		}
		expect(prepare).not.toHaveBeenCalled();
	}
);
