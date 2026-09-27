import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleCacheApi } from './router';
import { serveStore } from './store';
import { testDatabase } from './test-db';
import { invalidateCacheRow } from './cache-lookup';
import { clearUpstreamsMemo } from './missing-paths';
import { clearCandidateMemos, remainingFreshMs } from './metadata';
import { setCacheUpstreamModes } from './upstream-registry';
import type { ExecutionContext } from './platform';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

const fixture = testDatabase();
const env = { ATTIC_DB: fixture.db } as unknown as App.Platform['env'];

/**
 * A CachedStore loopback behind a modeled edge cache: cacheable responses are
 * stored by path and served back with an Age header, and purges drop entries
 * by Cache-Tag. Freshness is not modeled; purges are what these tests check.
 */
function edge() {
	const entries = new Map<string, { body: string; headers: Headers; storedAt: number }>();
	const invocations: string[] = [];
	const fetch = vi.fn(async (request: Request) => {
		const path = new URL(request.url).pathname;
		let entry = entries.get(path);
		if (!entry) {
			invocations.push(path);
			const response = await serveStore(request, env, ctx);
			const cacheControl = response.headers.get('Cache-Control') ?? '';
			if (!response.ok || !cacheControl.startsWith('public') || cacheControl.includes('no-store'))
				return response;
			entry = { body: await response.text(), headers: response.headers, storedAt: Date.now() };
			entries.set(path, entry);
		}
		const headers = new Headers(entry.headers);
		headers.set('Age', String(Math.floor((Date.now() - entry.storedAt) / 1000)));
		return new Response(entry.body, { headers });
	});
	const purge = async (tags: string[]) => {
		for (const [path, entry] of entries) {
			const entryTags = (entry.headers.get('Cache-Tag') ?? '').split(',');
			if (entryTags.some((t) => tags.includes(t))) entries.delete(path);
		}
	};
	const ctx = {
		exports: { CachedStore: { fetch, purgeTags: purge, enqueuePurgeTags: purge } },
		waitUntil: () => {}
	} as unknown as ExecutionContext;
	/** Store executions of the redirect resolver (edge misses only). */
	const resolutions = () => invocations.filter((p) => p.startsWith('/_upstream_nar/'));
	return { ctx, entries, resolutions };
}

const nar = (ctx: ExecutionContext, path: string) =>
	handleCacheApi(new Request(`https://cache.test${path}`), env, ctx);

let seq = 0;
const freshFile = () => `${(seq++).toString(36).padStart(52, '0')}.nar.xz`;

beforeEach(() => {
	invalidateCacheRow();
	clearUpstreamsMemo();
	clearCandidateMemos();
	fixture.sqlite.exec(
		'DELETE FROM object; DELETE FROM nar; DELETE FROM cache_upstream; DELETE FROM cache; DELETE FROM upstream_check; DELETE FROM upstream;'
	);
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'test','',1,'zstd',datetime('now'))"
	);
	fixture.sqlite.exec(
		"INSERT INTO upstream (id,url,public_key,ttl,default_mode,enforced,position,nix_default,created_at) VALUES (1,'https://upstream.test','',3600,'redirect',0,0,0,datetime('now'))"
	);
});
afterEach(() => vi.unstubAllGlobals());

it('serves repeat redirects from the edge and the gateway memo', async () => {
	const probe = vi.fn(async () => new Response(null, { status: 200 }));
	vi.stubGlobal('fetch', probe);
	const { ctx, entries, resolutions } = edge();
	const file = freshFile();

	const response = await nar(ctx, `/nar/${file}`);
	expect(response.status).toBe(302);
	expect(response.headers.get('Location')).toBe(`https://upstream.test/nar/${file}`);
	const entry = entries.get(`/_upstream_nar/~/${file}`)!;
	expect(entry.headers.get('Cache-Tag')).toBe('cache:~upstream');
	expect(entry.headers.get('Cache-Control')).toBe(
		'public, max-age=3600, stale-while-revalidate=300, stale-if-error=3600'
	);

	// Same isolate: the gateway memo answers without a loopback.
	expect((await nar(ctx, `/nar/${file}`)).status).toBe(302);
	// Another isolate (empty memo): an edge hit, with no store execution.
	clearUpstreamsMemo();
	expect((await nar(ctx, `/nar/${file}`)).status).toBe(302);
	expect(resolutions()).toHaveLength(1);
	expect(probe).toHaveBeenCalledOnce();
});

it('surfaces upstream uncertainty uncached, with the store backoff', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
	const { ctx, entries } = edge();

	const response = await nar(ctx, `/nar/${freshFile()}`);
	expect(response.status).toBe(503);
	expect(response.headers.get('Retry-After')).toBe('60');
	expect([...entries.keys()].some((p) => p.startsWith('/_upstream_nar/'))).toBe(false);
});

it('caches a confirmed miss briefly and never serves it stale on error', async () => {
	vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
	const { ctx, entries } = edge();
	const file = freshFile();

	expect((await nar(ctx, `/test/nar/${file}`)).status).toBe(404);
	const entry = entries.get(`/_upstream_nar/test/1/${file}`)!;
	expect(entry.headers.get('Cache-Control')).toBe('public, max-age=300, stale-if-error=0');
	expect(entry.headers.get('Cache-Tag')).toBe('upstream-pt:test');
});

it("purges root redirects when a cache's subscriptions change", async () => {
	vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
	const { ctx } = edge();
	const file = freshFile();
	expect((await nar(ctx, `/nar/${file}`)).status).toBe(302);

	// Disable the only enabled subscription: the root union is now empty.
	await setCacheUpstreamModes(fixture.db, 1, [{ upstreamId: 1, mode: 'off' }], {
		allowPersist: false,
		ctx,
		cacheName: 'test'
	});
	expect((await nar(ctx, `/nar/${file}`)).status).toBe(404);
});

it('never lets a recreated cache inherit its predecessor’s redirects', async () => {
	vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
	const { ctx } = edge();
	const file = freshFile();
	expect((await nar(ctx, `/test/nar/${file}`)).status).toBe(302);

	// The name is freed (a rename; createCache also reclaims a soft-deleted
	// name) and taken by a new cache with the upstream disabled, with no
	// purge in between.
	fixture.sqlite.exec("UPDATE cache SET name = 'renamed' WHERE id = 1");
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (2,'test','',1,'zstd',datetime('now'))"
	);
	fixture.sqlite.exec("INSERT INTO cache_upstream (cache_id,upstream_id,mode) VALUES (2,1,'off')");
	invalidateCacheRow('test');
	clearUpstreamsMemo();
	expect((await nar(ctx, `/test/nar/${file}`)).status).toBe(404);
});

it('refills a purged redirect from fresh configuration, not a stale memo', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
		const { ctx } = edge();
		const file = freshFile();
		// The only enabled subscription: off by default, on for 'test'.
		fixture.sqlite.exec("UPDATE upstream SET default_mode = 'off' WHERE id = 1");
		fixture.sqlite.exec(
			"INSERT INTO cache_upstream (cache_id,upstream_id,mode) VALUES (1,1,'redirect')"
		);
		expect((await nar(ctx, `/nar/${file}`)).status).toBe(302);

		// Deleted from another isolate: this one's config memo stays warm. The
		// deletion's purge lands, and this isolate's redirect memo expires.
		fixture.sqlite.exec("UPDATE cache SET deleted_at = datetime('now') WHERE id = 1");
		invalidateCacheRow();
		await ctx.exports!.CachedStore!.purgeTags(['cache:~upstream']);
		vi.setSystemTime(Date.now() + 301_000);
		expect((await nar(ctx, `/nar/${file}`)).status).toBe(404);
	} finally {
		vi.useRealTimers();
	}
});

it('reuses a loopback result only for its remaining edge freshness', () => {
	const fresh = (cacheControl: string, age?: number) =>
		remainingFreshMs(
			new Headers({
				'Cache-Control': cacheControl,
				...(age === undefined ? {} : { Age: String(age) })
			})
		);
	expect(fresh('public, max-age=300, stale-if-error=0')).toBe(300_000);
	expect(fresh('public, max-age=300, stale-if-error=0', 290)).toBe(10_000);
	// Served stale (SWR or stale-if-error): not reusable at all.
	expect(fresh('public, max-age=3600, stale-while-revalidate=300', 3700)).toBe(0);
	expect(fresh('no-store')).toBe(0);
	expect(fresh('public, stale-while-revalidate=300')).toBe(0);
});
