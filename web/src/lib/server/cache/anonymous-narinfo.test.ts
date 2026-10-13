import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleCacheApi } from './router';
import { invalidateAfterUpload, serveStore } from './store';
import { testDatabase } from './test-db';
import { invalidateCacheRow } from './cache-lookup';
import { clearCandidateMemos } from './metadata';
import { clearUpstreamsMemo } from './missing-paths';
import { configureCache } from './cache-config';
import { getProxyKeypair } from './proxy';
import * as proxy from './proxy';
import { extractPublicKey, generateKeypair } from '../attic/signing';
import * as signing from '../attic/signing';
import { buildNarInfo, narInfoSignatureValid } from '../attic/narinfo';
import { mintAtticToken } from '../attic-token';
import { persistUpstreamPath } from './pullthrough';
import * as db from './db';
import type { ExecutionContext } from './platform';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
vi.mock('./pullthrough', () => ({ persistUpstreamPath: vi.fn(async () => {}) }));

const fixture = testDatabase();
const env = {
	ATTIC_DB: fixture.db,
	CACHE_BASE_URL: 'https://cache.test',
	JWT_HS256_SECRET_BASE64: btoa('anonymous-narinfo-tests')
} as unknown as App.Platform['env'];
let sequence = 0;
const freshHash = () => `anonymous${(sequence++).toString().padStart(23, '0')}`;
const route = (hash: string) => `/_anonymous_narinfo_v1/${hash}`;

function edge() {
	const entries = new Map<string, { text: string; headers: Headers; storedAt: number }>();
	const tasks: Promise<unknown>[] = [];
	const purge = async (tags: string[]) => {
		for (const [path, entry] of entries) {
			if (
				entry.headers
					.get('Cache-Tag')
					?.split(',')
					.some((tag) => tags.includes(tag))
			)
				entries.delete(path);
		}
	};
	const fetch = vi.fn(async (request: Request) => {
		const url = new URL(request.url);
		const path = url.pathname + url.search;
		const cached = entries.get(path);
		if (cached)
			return new Response(cached.text, {
				headers: {
					...Object.fromEntries(cached.headers),
					'CF-Cache-Status': 'HIT',
					Age: String(Math.floor((Date.now() - cached.storedAt) / 1000))
				}
			});
		const response = await serveStore(request, env, ctx);
		const text = await response.text();
		if (response.ok && response.headers.get('Cache-Control')?.startsWith('public'))
			entries.set(path, { text, headers: new Headers(response.headers), storedAt: Date.now() });
		return new Response(text, response);
	});
	const ctx = {
		exports: { CachedStore: { fetch, purgeTags: purge, enqueuePurgeTags: purge } },
		waitUntil: (task: Promise<unknown>) => void tasks.push(task)
	} as unknown as ExecutionContext;
	const get = (hash: string, headers?: HeadersInit) =>
		handleCacheApi(new Request(`${env.CACHE_BASE_URL}/${hash}.narinfo`, { headers }), env, ctx);
	return { get, ctx, fetch, entries, tasks };
}

function hold(hash: string, cacheId = 1, suffix = 'test') {
	fixture.sqlite
		.prepare(
			"INSERT INTO nar (state,nar_hash,nar_size,compression,created_at) VALUES ('V', ?, 1, 'zstd', datetime('now'))"
		)
		.run(`sha256:${'b'.repeat(64)}`);
	fixture.sqlite
		.prepare(
			"INSERT INTO object (cache_id,nar_id,store_path_hash,store_path,created_at) VALUES (?, last_insert_rowid(), ?, ?, datetime('now'))"
		)
		.run(cacheId, hash, `/nix/store/${hash}-${suffix}`);
}

async function upstream(hash: string, mode = 'redirect') {
	const key = await generateKeypair('upstream');
	const text = await buildNarInfo(
		{
			store_path: `/nix/store/${hash}-upstream`,
			refs: '[]',
			sigs: '[]',
			system: null,
			deriver: null,
			ca: null
		},
		{ nar_hash: `sha256:${'c'.repeat(64)}`, nar_size: 100, compression: 'zstd' },
		[],
		key
	);
	fixture.sqlite
		.prepare(
			"INSERT INTO upstream (url,public_key,ttl,default_mode,enforced,position,nix_default,created_at) VALUES ('https://upstream.test/cache', ?, 3600, ?, 0, 0, 0, datetime('now'))"
		)
		.run(extractPublicKey(key), mode);
	const fetch = vi.fn(async () => new Response(text));
	vi.stubGlobal('fetch', fetch);
	return { text, key, fetch };
}

beforeEach(() => {
	invalidateCacheRow();
	clearCandidateMemos();
	clearUpstreamsMemo();
	fixture.sqlite.exec(
		'DELETE FROM object; DELETE FROM nar; DELETE FROM cache_upstream; DELETE FROM cache; DELETE FROM upstream_check; DELETE FROM upstream;'
	);
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'test','',1,'zstd',datetime('now'))"
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it('serves local narinfo in one warm loopback, with no D1 read on a warm hit', async () => {
	const hash = freshHash();
	hold(hash);
	const { get, fetch } = edge();
	const first = await get(hash);
	const text = await first.text();
	expect(await narInfoSignatureValid(text, extractPublicKey(await getProxyKeypair(env)))).toBe(
		true
	);
	expect(text).toContain(`StorePath: /nix/store/${hash}-test`);
	expect(text).not.toContain('winnerId');
	expect(first.headers.has('X-Nimbus-Filled-At')).toBe(false);
	const prepare = vi.spyOn(fixture.db, 'prepare');
	expect(await (await get(hash)).text()).toBe(text);
	expect(prepare).not.toHaveBeenCalled();
	expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
		route(hash),
		`/_proxy/test/${hash}.narinfo`,
		route(hash)
	]);
});

it.each(['both lookups', 'envelope lookup', 'body lookup'] as const)(
	'retries proxy signing on the next anonymous request after failure of %s',
	async (failure) => {
		const hash = freshHash();
		hold(hash);
		const keypair = await getProxyKeypair(env);
		const publicKey = extractPublicKey(keypair);
		const lookup = vi.spyOn(proxy, 'getProxyKeypair').mockResolvedValue(keypair);
		const unavailable = new Error('temporary proxy-key lookup failure');
		if (failure === 'body lookup') lookup.mockResolvedValueOnce(keypair);
		else lookup.mockRejectedValueOnce(unavailable);
		if (failure === 'envelope lookup') lookup.mockResolvedValueOnce(keypair);
		else lookup.mockRejectedValueOnce(unavailable);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { get, entries } = edge();
		const fallback = await get(hash);
		expect(fallback.status).toBe(200);
		expect(await narInfoSignatureValid(await fallback.text(), publicKey)).toBe(
			failure === 'envelope lookup'
		);
		expect(entries.has(route(hash))).toBe(false);
		if (failure !== 'envelope lookup') expect(entries.size).toBe(0);
		const recovered = await get(hash);
		expect(recovered.status).toBe(200);
		expect(await narInfoSignatureValid(await recovered.text(), publicKey)).toBe(true);
		expect(entries.has(route(hash))).toBe(true);
		const reads = lookup.mock.calls.length;
		expect(await narInfoSignatureValid(await (await get(hash)).text(), publicKey)).toBe(true);
		expect(lookup).toHaveBeenCalledTimes(reads);
	}
);

it('does not cache a stored-signature fallback when proxy signing itself fails', async () => {
	const hash = freshHash();
	hold(hash);
	fixture.sqlite.exec(`UPDATE object SET sigs = '["foreign:AAAA"]'`);
	const publicKey = extractPublicKey(await getProxyKeypair(env));
	vi.spyOn(signing, 'signMessage').mockRejectedValueOnce(new Error('temporary signing failure'));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const { get, entries } = edge();
	const fallback = await get(hash);
	expect(fallback.status).toBe(200);
	expect(await fallback.text()).toContain('Sig: foreign:AAAA');
	expect(entries.size).toBe(0);
	const recovered = await get(hash);
	expect(await narInfoSignatureValid(await recovered.text(), publicKey)).toBe(true);
	expect(entries.has(route(hash))).toBe(true);
});

it('rechecks visibility even when a public-to-private purge was missed', async () => {
	const hash = freshHash();
	hold(hash);
	const { get, entries } = edge();
	expect((await get(hash)).status).toBe(200);
	fixture.sqlite.exec('UPDATE cache SET is_public = 0 WHERE id = 1');
	invalidateCacheRow();
	expect(entries.has(route(hash))).toBe(true);
	const response = await get(hash);
	expect(response.status).toBe(404);
	expect(await response.text()).not.toContain('StorePath:');
});

it('never lets a recreated cache inherit a cached selection', async () => {
	const hash = freshHash();
	hold(hash);
	const { get } = edge();
	expect((await get(hash)).status).toBe(200);
	fixture.sqlite.exec(
		"DELETE FROM object; UPDATE cache SET name = 'old', deleted_at = datetime('now'); INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (2,'test','',1,'zstd',datetime('now'))"
	);
	hold(hash, 2, 'new');
	invalidateCacheRow();
	const response = await get(hash);
	expect(response.status).toBe(200);
	expect(await response.text()).toContain(`StorePath: /nix/store/${hash}-new`);
});

it('uses existing priority purges to select a different public holder', async () => {
	const hash = freshHash();
	hold(hash);
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,priority,compression,created_at) VALUES (2,'other','',1,50,'zstd',datetime('now'))"
	);
	hold(hash, 2, 'other');
	const { get, ctx, entries } = edge();
	expect(await (await get(hash)).text()).toContain(`${hash}-test`);
	await configureCache(env, 'other', { priority: 10 }, { ctx });
	expect(entries.has(route(hash))).toBe(false);
	expect(await (await get(hash)).text()).toContain(`${hash}-other`);
});

it('serves upstream narinfo in one warm loopback with an absolute, still-signed URL', async () => {
	const hash = freshHash();
	const remote = await upstream(hash);
	const { get, fetch } = edge();
	const text = await (await get(hash)).text();
	expect(text).toContain('URL: https://upstream.test/cache/nar/');
	expect(await narInfoSignatureValid(text, extractPublicKey(remote.key))).toBe(true);
	const prepare = vi.spyOn(fixture.db, 'prepare');
	expect(await (await get(hash)).text()).toBe(text);
	expect(prepare).not.toHaveBeenCalled();
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(remote.fetch).toHaveBeenCalledOnce();
});

it('keeps pull-through on the gateway context and strips its internal markers', async () => {
	const hash = freshHash();
	await upstream(hash, 'persist');
	const { get, tasks } = edge();
	for (let i = 0; i < 2; i++) {
		const response = await get(hash);
		expect(response.status).toBe(200);
		for (const header of [
			'X-Nimbus-Persist-Cache',
			'X-Nimbus-Persist-Upstream',
			'X-Nimbus-Via-Upstream'
		])
			expect(response.headers.has(header)).toBe(false);
	}
	await Promise.all(tasks);
	expect(persistUpstreamPath).toHaveBeenCalledTimes(2);
	expect(vi.mocked(persistUpstreamPath).mock.calls[0][4]).toContain(
		'URL: https://upstream.test/cache/nar/'
	);
});

it('reuses a fresh upstream body when five-minute candidate metadata refills', async () => {
	const hash = freshHash();
	const remote = await upstream(hash);
	const { get, entries } = edge();
	expect((await get(hash)).status).toBe(200);
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime(Date.now() + 301_000);
		entries.delete(route(hash));
		const response = await get(hash);
		expect(response.status).toBe(200);
		expect(response.headers.get('Age')).toBe('301');
		expect(remote.fetch).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
	}
});

it('evicts upstream selections when an upload lands, using existing tags', async () => {
	const hash = freshHash();
	await upstream(hash);
	const { get, ctx, entries, tasks } = edge();
	expect(await (await get(hash)).text()).toContain(`${hash}-upstream`);
	hold(hash);
	await invalidateAfterUpload(ctx, (await db.findCache(fixture.db, 'test'))!, hash, 'b'.repeat(64));
	await Promise.all(tasks);
	expect(entries.has(route(hash))).toBe(false);
	expect(await (await get(hash)).text()).toContain(`${hash}-test`);
});

it('confirms a forty-five-second-old empty hit even while its five-minute TTL is fresh', async () => {
	const hash = freshHash();
	const { get, entries } = edge();
	expect((await get(hash)).status).toBe(404);
	// Root absence is separately memoized; advance past that window first.
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime(Date.now() + 61_000);
		entries.get(route(hash))!.headers.set('X-Nimbus-Filled-At', String(Date.now() - 45_000));
		hold(hash);
		const response = await get(hash);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(`${hash}-test`);
	} finally {
		vi.useRealTimers();
	}
});

it('does not cache upstream uncertainty or remember it as absence', async () => {
	const hash = freshHash();
	const remote = await upstream(hash);
	remote.fetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
	const { get, entries } = edge();
	expect((await get(hash)).status).toBe(503);
	expect(entries.has(route(hash))).toBe(false);
	expect((await get(hash)).status).toBe(200);
});

it('retains authenticated private-cache routing and strips authorization at the store', async () => {
	const hash = freshHash();
	fixture.sqlite.exec('UPDATE cache SET is_public = 0');
	hold(hash);
	const token = await mintAtticToken(env.JWT_HS256_SECRET_BASE64!, 'reader', { test: { r: 1 } });
	const { get, fetch } = edge();
	expect((await get(hash, { Authorization: `Bearer ${token}` })).status).toBe(200);
	expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
		`/_meta/path/${hash}`,
		`/_proxy/test/${hash}.narinfo`
	]);
	for (const [request] of fetch.mock.calls)
		expect(request.headers.has('Authorization')).toBe(false);
});

it('reuses week-old metadata while refreshing a narinfo past its upstream lifetime', async () => {
	const hash = freshHash();
	const remote = await upstream(hash);
	const { get, fetch, entries } = edge();
	expect((await get(hash)).status).toBe(200);
	expect(entries.get(route(hash))!.headers.get('Cache-Control')).toBe(
		'public, max-age=300, stale-while-revalidate=604800, stale-if-error=0'
	);
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime(Date.now() + 6 * 24 * 60 * 60 * 1000);
		clearUpstreamsMemo();
		for (const path of entries.keys())
			if (path.startsWith('/_proxy_upstream/')) entries.delete(path);
		const prepare = vi.spyOn(fixture.db, 'prepare');
		expect((await get(hash)).status).toBe(200);
		expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
			route(hash),
			`/_proxy_upstream/${hash}.narinfo`,
			route(hash),
			`/_proxy_upstream/${hash}.narinfo`
		]);
		expect(
			prepare.mock.calls.filter(([sql]) => sql.includes('o.store_path_hash = ?1'))
		).toHaveLength(0);
		expect(remote.fetch).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
	}
});

it('keeps the anonymous internal route inaccessible through the public gateway', async () => {
	const hash = freshHash();
	hold(hash);
	const { ctx } = edge();
	expect(
		(await handleCacheApi(new Request(`${env.CACHE_BASE_URL}${route(hash)}`), env, ctx)).status
	).toBeGreaterThanOrEqual(400);
});

it('recovers a combined transport failure through separate metadata and body reads', async () => {
	const hash = freshHash();
	hold(hash);
	const { get, fetch } = edge();
	fetch.mockRejectedValueOnce(new Error('loopback reset'));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	expect((await get(hash)).status).toBe(200);
	expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
		route(hash),
		`/_meta/path/${hash}`,
		`/_proxy/test/${hash}.narinfo`
	]);
});
