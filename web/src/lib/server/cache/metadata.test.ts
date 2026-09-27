import { expect, it, vi } from 'vitest';
import { loadCandidates, loadManifest, touchViaStore } from './metadata';
import type { ExecutionContext } from './platform';
import { AdmissionError } from './admission';

it('cached candidate, manifest and retention responses require no gateway D1 access or credentials', async () => {
	const prepare = vi.fn(() => {
		throw new Error('unexpected D1 access');
	});
	const requests: Request[] = [];
	const fetch = vi.fn(async (r: Request) => {
		requests.push(r);
		return new Response(
			r.url.includes('/_touch/') ? 'ok' : r.url.includes('/_meta/') ? '[]' : 'null'
		);
	});
	const ctx = { exports: { CachedStore: { fetch } } } as unknown as ExecutionContext;
	const env = {
		ATTIC_DB: { prepare },
		CACHE_BASE_URL: 'https://cache.test'
	} as unknown as App.Platform['env'];
	const request = new Request('https://cache.test/nar/a.nar?bust=1', {
		headers: {
			Authorization: 'Bearer secret',
			Cookie: 'session=secret',
			'CF-Connecting-IP': '203.0.113.7'
		}
	});
	expect(await loadCandidates(env, ctx, request, 'nar', 'sha256:abc')).toEqual({
		rows: [],
		listed: false
	});
	expect(await loadManifest(env, ctx, 'abc')).toBeNull();
	await touchViaStore(env, ctx, 1, 'abc');
	expect(prepare).not.toHaveBeenCalled();
	expect(requests[0].url).toBe('https://cache.test/_meta/nar/abc');
	for (const r of requests) {
		expect(r.headers.has('Authorization')).toBe(false);
		expect(r.headers.has('Cookie')).toBe(false);
	}
});

it('does not interpret a failed cached metadata fetch as absence', async () => {
	const ctx = {
		exports: { CachedStore: { fetch: async () => new Response(null, { status: 503 }) } }
	} as unknown as ExecutionContext;
	await expect(
		loadCandidates({} as App.Platform['env'], ctx, new Request('https://cache.test'), 'path', 'abc')
	).rejects.toBeInstanceOf(AdmissionError);
});

it('charges the uncached candidates fallback like a store miss', async () => {
	const prepare = vi.fn();
	const denied = { limit: async () => ({ success: false }) };
	const env = {
		ATTIC_DB: { prepare },
		BACKEND_READ_LIMITER: denied
	} as unknown as App.Platform['env'];
	const request = new Request('https://cache.test/nar/a.nar', {
		headers: { 'CF-Connecting-IP': '203.0.113.7' }
	});
	// No CachedStore at all, and a caching-layer 502: both fall back to the
	// direct path and must still pay admission.
	await expect(loadCandidates(env, undefined, request, 'nar', 'abc')).rejects.toBeInstanceOf(
		AdmissionError
	);
	const ctx = {
		exports: { CachedStore: { fetch: async () => new Response(null, { status: 502 }) } }
	} as unknown as ExecutionContext;
	await expect(loadCandidates(env, ctx, request, 'nar', 'abc')).rejects.toBeInstanceOf(
		AdmissionError
	);
	expect(prepare).not.toHaveBeenCalled();
});

it('memoizes positive membership without retaining obsolete visibility', async () => {
	const { testDatabase } = await import('./test-db');
	const { invalidateCacheRow } = await import('./cache-lookup');
	const { clearCandidateMemos, invalidateCandidates } = await import('./metadata');
	clearCandidateMemos();
	invalidateCacheRow();
	const { sqlite, db } = testDatabase();
	try {
		sqlite.exec(
			"INSERT INTO cache (id, name, keypair, is_public, created_at) VALUES (1, 'test', '', 1, datetime('now'))"
		);
		const fetch = vi.fn(async () => Response.json([{ id: 1, name: 'test', is_public: 1 }]));
		const ctx = { exports: { CachedStore: { fetch } } } as unknown as ExecutionContext;
		const env = { ATTIC_DB: db } as App.Platform['env'];
		const request = new Request('https://cache.test');
		expect((await loadCandidates(env, ctx, request, 'path', 'visibility')).rows[0].is_public).toBe(
			1
		);
		sqlite.exec('UPDATE cache SET is_public = 0 WHERE id = 1');
		invalidateCacheRow('test');
		expect((await loadCandidates(env, ctx, request, 'path', 'visibility')).rows[0].is_public).toBe(
			0
		);
		expect(fetch).toHaveBeenCalledOnce();
		invalidateCandidates('path', 'visibility');
		await loadCandidates(env, ctx, request, 'path', 'visibility');
		expect(fetch).toHaveBeenCalledTimes(2);
	} finally {
		sqlite.close();
		clearCandidateMemos();
		invalidateCacheRow();
	}
});

it('does not memoize empty candidate entries', async () => {
	const fetch = vi.fn(async () => Response.json([]));
	const ctx = { exports: { CachedStore: { fetch } } } as unknown as ExecutionContext;
	const env = {} as App.Platform['env'];
	const request = new Request('https://cache.test');
	await loadCandidates(env, ctx, request, 'nar', 'empty');
	await loadCandidates(env, ctx, request, 'nar', 'empty');
	expect(fetch).toHaveBeenCalledTimes(2);
});
