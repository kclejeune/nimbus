import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { testDatabase } from './test-db';
import type { ExecutionContext } from './platform';
import type { Upstream } from './missing-paths';

let upstreams: typeof import('./missing-paths');
let fixture: ReturnType<typeof testDatabase>;
beforeEach(async () => {
	vi.resetModules();
	upstreams = await import('./missing-paths');
	fixture = testDatabase({ admin: true });
	fixture.sqlite.exec(`
		INSERT INTO cache (id,name,keypair,compression,created_at) VALUES (1,'test','','zstd',datetime('now'));
		INSERT INTO upstream (id,url,public_key,ttl,default_mode,enforced,position,created_at) VALUES (1,'https://up.example','',86400,'redirect',0,0,datetime('now'));
		INSERT INTO cache_upstream (cache_id,upstream_id,mode) VALUES (1,1,'persist');
	`);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	fixture.sqlite.close();
});

function stalledReplica() {
	let resolve!: (results: D1Result[]) => void;
	const pending = new Promise<D1Result[]>((done) => (resolve = done));
	const batch = vi.fn((_statements: D1PreparedStatement[]) => pending);
	const replica = { prepare: fixture.db.prepare.bind(fixture.db), batch } as unknown as D1Database;
	const sessions = vi
		.spyOn(fixture.db, 'withSession')
		.mockImplementation(
			(constraint) => (constraint === 'first-primary' ? fixture.db : replica) as never
		);
	const tasks: Promise<unknown>[] = [];
	const ctx = { waitUntil: (work: Promise<unknown>) => void tasks.push(work) } as ExecutionContext;
	return {
		sessions,
		batch,
		tasks,
		ctx,
		finish: () =>
			resolve(
				[0, 1, 2, 3].map(() => ({ results: [], success: true, meta: {} }) as unknown as D1Result)
			)
	};
}

it('hedges a stalled config refill and memoizes the resolved subscription modes', async () => {
	const { sessions, ctx, tasks, finish } = stalledReplica();
	try {
		const reading = upstreams.allLiveUpstreams(fixture.db, ctx);
		await vi.advanceTimersByTimeAsync(499);
		expect(sessions).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await reading).toMatchObject([{ id: 1, mode: 'persist', persistInto: 'test' }]);
		expect(sessions).toHaveBeenCalledWith('first-primary');
		expect(
			await upstreams.upstreamsForCache(fixture.db, { id: 1, name: 'test' }, ctx)
		).toHaveLength(1);
		expect(sessions).toHaveBeenCalledTimes(2);
	} finally {
		finish();
		await Promise.all(tasks);
	}
});

it('hedges the whole fresh redirect snapshot and rechecks lifecycle and subscriptions on the next fill', async () => {
	const filename = `${'a'.repeat(52)}.nar.zst`;
	fixture.sqlite
		.prepare(
			'INSERT INTO upstream_check (upstream_id,store_path_hash,present,checked_at) VALUES (1,?,1,?)'
		)
		.run(`nar:nar/${filename}`, new Date().toISOString());
	const { sessions, batch, ctx, tasks, finish } = stalledReplica();
	const env = { ATTIC_DB: fixture.db } as App.Platform['env'];
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	try {
		const reading = upstreams.resolveUpstreamNar(env, ctx, { id: 1, name: 'test' }, filename);
		await vi.advanceTimersByTimeAsync(500);
		expect(await reading).toBe(`https://up.example/nar/${filename}`);
		expect(batch.mock.calls[0][0]).toHaveLength(4);
		expect(sessions).toHaveBeenCalledWith('first-primary');
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		finish();
		await Promise.all(tasks);
	}
	sessions.mockImplementation(() => fixture.db as never);
	fixture.sqlite.exec("UPDATE cache_upstream SET mode = 'off'");
	expect(await upstreams.resolveUpstreamNar(env, ctx, { id: 1, name: 'test' }, filename)).toBe(
		null
	);
	fixture.sqlite.exec("UPDATE cache SET deleted_at = datetime('now')");
	expect(
		await upstreams.resolveUpstreamNar(env, ctx, { id: 1, name: 'test' }, filename)
	).toBeUndefined();
	expect(fetch).not.toHaveBeenCalled();
});

function twoUpstreams(): Upstream[] {
	fixture.sqlite.exec(`
		INSERT INTO upstream (id,url,public_key,ttl,default_mode,enforced,position,created_at)
		VALUES (2,'https://second.example','',86400,'redirect',0,1,datetime('now'));
	`);
	return [1, 2].map((id) => ({
		id,
		url: `https://up${id}.example`,
		publicKey: null,
		ttl: 86400,
		mode: 'redirect',
		persistInto: null,
		nixDefault: false
	}));
}

it('reads a closure spanning hash windows for every upstream in one replica batch', async () => {
	const live = twoUpstreams();
	const hashes = Array.from({ length: 2001 }, (_, i) => i.toString(16).padStart(32, '0'));
	const insert = fixture.sqlite.prepare(
		'INSERT INTO upstream_check (upstream_id,store_path_hash,present,checked_at) VALUES (2,?,1,?)'
	);
	const now = new Date().toISOString();
	fixture.sqlite.exec('BEGIN');
	for (const hash of hashes) insert.run(hash, now);
	fixture.sqlite.exec('COMMIT');
	const batch = vi.spyOn(fixture.db, 'batch');
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	expect(await upstreams.filterUpstreamPaths(fixture.db, live, hashes)).toEqual({
		missing: [],
		deferred: []
	});
	expect(batch).toHaveBeenCalledOnce();
	expect(batch.mock.calls[0][0]).toHaveLength(2);
	expect(fetch).not.toHaveBeenCalled();
});

it('preserves each upstream TTL, absent recheck time and persist-mode restrictions', async () => {
	const live = twoUpstreams();
	live[0].ttl = 1;
	live[1].mode = 'persist';
	const [expired, absent, unpersistable, laterHit] = ['a', 'b', 'c', 'd'].map((s) => s.repeat(32));
	const recent = new Date().toISOString();
	const old = new Date(Date.now() - 3600_000).toISOString();
	const insert = fixture.sqlite.prepare(
		'INSERT INTO upstream_check (upstream_id,store_path_hash,present,checked_at) VALUES (?,?,?,?)'
	);
	insert.run(1, expired, 1, old);
	insert.run(2, expired, 0, recent);
	insert.run(1, absent, 0, old);
	insert.run(2, absent, 0, recent);
	insert.run(1, unpersistable, 0, recent);
	insert.run(2, unpersistable, upstreams.VERDICT_UNPERSISTABLE, recent);
	insert.run(2, laterHit, 1, old);
	const fetch = vi.fn(async () => new Response(null, { status: 404 }));
	vi.stubGlobal('fetch', fetch);
	expect(
		await upstreams.filterUpstreamPaths(fixture.db, live, [
			expired,
			absent,
			unpersistable,
			laterHit
		])
	).toEqual({ missing: [expired, absent, unpersistable], deferred: [] });
	expect(fetch).toHaveBeenCalledOnce();
	expect(fetch.mock.calls[0]).toBeDefined();
});

it('does not issue a verdict batch for an empty closure', async () => {
	const batch = vi.spyOn(fixture.db, 'batch');
	expect(await upstreams.filterUpstreamPaths(fixture.db, twoUpstreams(), [])).toEqual({
		missing: [],
		deferred: []
	});
	expect(batch).not.toHaveBeenCalled();
});

it('observes another isolate’s edge purge without retaining an older local snapshot', async () => {
	let cached: Response | undefined;
	let filledAt = Date.now();
	const env = { ATTIC_DB: fixture.db, CACHE_BASE_URL: 'https://cache.test' } as App.Platform['env'];
	const fetch = vi.fn(async () => {
		if (!cached) {
			cached = await upstreams.serveUpstreamConfig(env);
			filledAt = Date.now();
		}
		const response = cached.clone();
		response.headers.set('Age', String(Math.floor((Date.now() - filledAt) / 1000)));
		return response;
	});
	const ctx = { exports: { CachedStore: { fetch } } } as unknown as ExecutionContext;
	expect((await upstreams.cachedUpstreamConfig(env, ctx)).overrides.get(1)?.get(1)).toBe('persist');
	const prepare = vi.spyOn(fixture.db, 'prepare');
	expect((await upstreams.cachedUpstreamConfig(env, ctx)).overrides.get(1)?.get(1)).toBe('persist');
	expect(prepare).not.toHaveBeenCalled();
	fixture.sqlite.exec("UPDATE cache_upstream SET mode = 'off'");
	cached = undefined; // Purged by another isolate; do not clear this one's memos.
	expect((await upstreams.cachedUpstreamConfig(env, ctx)).overrides.get(1)?.get(1)).toBe('off');
	expect(fetch).toHaveBeenCalledTimes(3);
	// A missed purge is still bounded: never use an expired trust snapshot.
	fixture.sqlite.exec("UPDATE cache_upstream SET mode = 'persist'");
	await vi.advanceTimersByTimeAsync(600_000);
	expect((await upstreams.cachedUpstreamConfig(env, ctx)).overrides.get(1)?.get(1)).toBe('persist');
	expect(fetch).toHaveBeenCalledTimes(4);
});

it('purges the shared configuration when subscription or cache lifecycle changes', async () => {
	const { setCacheUpstreamModes } = await import('./upstream-registry');
	const { createCache, renameCache, configureCache, destroyCache } = await import('./cache-config');
	const purgeTags = vi.fn(async (_tags: string[]) => {});
	const ctx = { exports: { CachedStore: { purgeTags } } } as unknown as ExecutionContext;
	const env = { ATTIC_DB: fixture.db } as App.Platform['env'];
	await setCacheUpstreamModes(fixture.db, 1, [{ upstreamId: 1, mode: 'off' }], {
		allowPersist: true,
		ctx,
		cacheName: 'test'
	});
	await createCache(env, 'new-cache', {}, undefined, ctx);
	await renameCache(env, 'new-cache', 'renamed', ctx);
	await configureCache(env, 'renamed', { priority: 1 }, { trustAuthorized: true, ctx });
	await destroyCache(env, 'renamed', ctx);
	expect(purgeTags).toHaveBeenCalledTimes(5);
	for (const [tags] of purgeTags.mock.calls) expect(tags).toContain(upstreams.UPSTREAM_CONFIG_TAG);
});
