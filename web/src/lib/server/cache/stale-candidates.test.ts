import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleCacheApi } from './router';
import { testDatabase } from './test-db';
import { invalidateCacheRow } from './cache-lookup';
import { candidateTag, clearCandidateMemos, serveCandidates } from './metadata';
import type { ExecutionContext } from './platform';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

const fixture = testDatabase();
const env = {
	ATTIC_DB: fixture.db,
	CACHE_BASE_URL: 'https://cache.test'
} as unknown as App.Platform['env'];

const refused = {
	...env,
	BACKEND_READ_LIMITER: { limit: async () => ({ success: false }) }
} as unknown as App.Platform['env'];

let seq = 0;
const freshHash = () => `stale${(seq++).toString().padStart(27, '0')}`;
/** A NAR hash distinct from, but derived from, a store path hash. */
const narHashFor = (hash: string) => `0${hash.slice(1)}`.padEnd(52, '0');

/** A root-endpoint read, optionally charged to a client's budget. */
function get(
	ctx: ExecutionContext,
	path: string,
	options: { env?: App.Platform['env']; clientIp?: string } = {}
): Promise<Response> {
	const headers: Record<string, string> = options.clientIp
		? { 'CF-Connecting-IP': options.clientIp }
		: {};
	return handleCacheApi(
		new Request(`https://cache.test/${path}`, { headers }),
		options.env ?? env,
		ctx
	);
}

/** An empty candidate entry as the edge would return it: filled a minute ago
 * (past the 30 s max-age, so served stale) or just now. */
function emptyEntry(entry: 'stale' | 'fresh', cfCacheStatus = 'HIT'): Response {
	const filledAt = Date.now() - (entry === 'stale' ? 60_000 : 0);
	return Response.json([], {
		headers: { 'CF-Cache-Status': cfCacheStatus, 'X-Nimbus-Filled-At': String(filledAt) }
	});
}

/** A CachedStore whose candidate entries are empty and stale or fresh (or
 * `meta`), whose upstreams all miss (or fail), and whose local routes serve
 * the path. `route` overrides every non-candidate route. */
function store(
	entry: 'stale' | 'fresh',
	upstream: 'miss' | 'fail' | 'throw' = 'miss',
	overrides: { meta?: Response; route?: (path: string) => Response } = {}
) {
	const purged: string[] = [];
	const fetch = vi.fn(async (request: Request) => {
		const path = new URL(request.url).pathname;
		if (path.startsWith('/_meta/')) return overrides.meta?.clone() ?? emptyEntry(entry);
		if (overrides.route) return overrides.route(path);
		const failed = () =>
			new Response(null, {
				status: 503,
				headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' }
			});
		if (path.startsWith('/_proxy_upstream/')) {
			if (upstream === 'throw') throw new Error('loopback reset');
			return upstream === 'fail' ? failed() : new Response(null, { status: 404 });
		}
		if (path.startsWith('/_upstream_nar/'))
			return upstream === 'fail'
				? failed()
				: Response.json(null, { headers: { 'Cache-Control': 'public, max-age=300' } });
		return new Response('local', { headers: { 'CF-Cache-Status': 'HIT' } });
	});
	const ctx = {
		exports: {
			CachedStore: {
				fetch,
				enqueuePurgeTags: async (tags: string[]) => void purged.push(...tags)
			}
		},
		waitUntil: (p: Promise<unknown>) => void p
	} as unknown as ExecutionContext;
	return { ctx, fetch, purged };
}

function holdLocally(storePathHash: string, narHash: string) {
	fixture.sqlite
		.prepare(
			"INSERT INTO nar (id,state,nar_hash,nar_size,compression,created_at) VALUES (?, 'V', ?, 1, 'zstd', datetime('now'))"
		)
		.run(seq, `sha256:${narHash}`);
	fixture.sqlite
		.prepare(
			"INSERT INTO object (cache_id,nar_id,store_path_hash,store_path,created_at) VALUES (1, ?, ?, ?, datetime('now'))"
		)
		.run(seq, storePathHash, `/nix/store/${storePathHash}-x`);
}

afterEach(() => {
	vi.restoreAllMocks();
});

beforeEach(() => {
	invalidateCacheRow();
	clearCandidateMemos();
	fixture.sqlite.exec('DELETE FROM object; DELETE FROM nar; DELETE FROM cache;');
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'test','',1,'zstd',datetime('now'))"
	);
});

it('serves empty candidate entries stale, but never stale on error', async () => {
	const response = await serveCandidates(new Request('https://cache.test'), env, 'path', 'none');
	expect(await response.json()).toEqual([]);
	expect(Number(response.headers.get('X-Nimbus-Filled-At'))).toBeGreaterThan(0);
	expect(response.headers.get('Cache-Control')).toBe(
		'public, max-age=30, stale-while-revalidate=300, stale-if-error=0'
	);
});

it('confirms a stale empty entry before a root narinfo 404, finding a fresh upload', async () => {
	const hash = freshHash();
	holdLocally(hash, `nar${hash}`);
	const { ctx, fetch, purged } = store('stale');

	const response = await get(ctx, `${hash}.narinfo`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('local');
	const paths = fetch.mock.calls.map(([r]) => new URL(r.url).pathname);
	expect(paths).toContain(`/_proxy/test/${hash}.narinfo`);
	// The confirmed membership evicts the stale empty entry.
	expect(purged).toContain(candidateTag('path', hash));
});

it('answers a refused confirmation with a retryable 503, never a 404', async () => {
	const hash = freshHash();
	holdLocally(hash, `nar${hash}`);
	const { ctx } = store('stale');
	const clientIp = '203.0.113.9';

	const response = await get(ctx, `${hash}.narinfo`, { env: refused, clientIp });
	expect(response.status).toBe(503);
	expect(response.headers.get('Retry-After')).toBeTruthy();
	// Nothing was memoized as absent: the next budgeted read finds the path.
	expect((await get(ctx, `${hash}.narinfo`, { clientIp })).status).toBe(200);
});

it('recovers local content from a stale empty entry when the upstreams fail', async () => {
	const hash = freshHash();
	const narHash = narHashFor(hash);
	holdLocally(hash, narHash);
	const { ctx } = store('stale', 'fail');

	const narinfo = await get(ctx, `${hash}.narinfo`);
	expect(narinfo.status).toBe(200);
	expect(await narinfo.text()).toBe('local');
	const nar = await get(ctx, `nar/${narHash}.nar.zst`);
	expect(nar.status).toBe(200);
	expect(await nar.text()).toBe('local');
});

it('recovers local content when the narinfo upstream loopback throws', async () => {
	const hash = freshHash();
	holdLocally(hash, `nar${hash}`);
	const { ctx } = store('stale', 'throw');
	const response = await get(ctx, `${hash}.narinfo`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('local');

	// Nothing local: the loopback's failure is still the answer, not a 404.
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const missing = await get(ctx, `${freshHash()}.narinfo`);
	expect(missing.status).toBeGreaterThanOrEqual(500);
});

it('releases the upstream response when confirmation is refused', async () => {
	const hash = freshHash();
	const cancel = vi.fn();
	const { ctx } = store('stale', 'miss', {
		route: () => new Response(new ReadableStream({ cancel }), { status: 503 })
	});
	const response = await get(ctx, `${hash}.narinfo`, { env: refused, clientIp: '203.0.113.9' });
	expect(response.status).toBe(503);
	expect(cancel).toHaveBeenCalledOnce();
});

it('still surfaces upstream failure when a stale empty entry confirms empty', async () => {
	const hash = freshHash();
	const { ctx } = store('stale', 'fail');
	expect((await get(ctx, `${hash}.narinfo`)).status).toBe(503);
	expect((await get(ctx, `nar/${hash.padEnd(52, '0')}.nar.zst`)).status).toBe(503);
});

it('leaves a fresh empty entry unconfirmed', async () => {
	const hash = freshHash();
	holdLocally(hash, `nar${hash}`);
	const { ctx, purged } = store('fresh');

	const response = await get(ctx, `${hash}.narinfo`);
	expect(response.status).toBe(404);
	expect(purged).toEqual([]);
});

it('confirms a stale empty entry before a root NAR 404, finding a fresh upload', async () => {
	const hash = freshHash();
	const narHash = narHashFor(hash);
	holdLocally(hash, narHash);
	const { ctx, purged } = store('stale');

	const response = await get(ctx, `nar/${narHash}.nar.zst`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('local');
	expect(purged).toContain(candidateTag('nar', narHash));
});

it('records a recovered root NAR once, as a hit', async () => {
	const hash = freshHash();
	const narHash = narHashFor(hash);
	holdLocally(hash, narHash);
	const writeDataPoint = vi.fn();
	const metered = {
		...env,
		CACHE_METRICS: { writeDataPoint },
		CACHE_METRICS_SAMPLE: '1'
	} as unknown as App.Platform['env'];
	const { ctx } = store('stale');

	const response = await get(ctx, `nar/${narHash}.nar.zst`, { env: metered });
	expect(response.status).toBe(200);
	const reads = writeDataPoint.mock.calls
		.map(([point]) => point.blobs)
		.filter((blobs: string[]) => blobs[0] === 'nar');
	expect(reads.map((blobs: string[]) => blobs[1])).toEqual(['hit']);
});

it('redirects upstream-only NARs from a stale empty entry without a primary read', async () => {
	const hash = freshHash().padEnd(52, '0');
	const { ctx } = store('stale', 'miss', {
		route: () =>
			Response.json('https://upstream.test/nar/x', {
				headers: { 'Cache-Control': 'public, max-age=3600' }
			})
	});
	const prepare = vi.spyOn(fixture.db, 'prepare');
	const response = await get(ctx, `nar/${hash}.nar.zst`);
	expect(response.status).toBe(302);
	expect(prepare).not.toHaveBeenCalled();
});

it('confirms a stale empty entry on a replica, not the primary', async () => {
	const hash = freshHash();
	holdLocally(hash, `nar${hash}`);
	const { ctx } = store('stale');
	const withSession = vi.spyOn(
		fixture.db as unknown as { withSession: (constraint?: string) => unknown },
		'withSession'
	);
	const response = await get(ctx, `${hash}.narinfo`);
	expect(response.status).toBe(200);
	expect(withSession.mock.calls.map(([c]) => c)).not.toContain('first-primary');
});

it('accepts replica-lag narinfo misses until the negative memos expire, then recovers', async () => {
	const hash = freshHash();
	holdLocally(hash, `nar${hash}`);
	const replica = testDatabase();
	let caughtUp = false;
	// The upload is committed on primary, but the replica initially lacks it.
	const withSession = vi.fn((constraint?: string) =>
		constraint === 'first-primary' || caughtUp ? fixture.db : replica.db
	);
	const laggedEnv = {
		...env,
		ATTIC_DB: { ...fixture.db, withSession }
	} as unknown as App.Platform['env'];
	const { ctx, fetch, purged } = store('stale');
	vi.useFakeTimers({ toFake: ['Date'] });
	const start = Date.now();
	try {
		expect((await get(ctx, `${hash}.narinfo`, { env: laggedEnv })).status).toBe(404);
		expect(withSession.mock.calls.map(([constraint]) => constraint)).not.toContain('first-primary');
		const initialFetches = fetch.mock.calls.length;
		const initialReads = withSession.mock.calls.length;
		caughtUp = true;
		// Replication catches up, and the 30 s empty-candidate memo expires,
		// but the 60 s root-narinfo absence memo still short-circuits requests.
		for (const elapsed of [1_000, 30_000, 59_999]) {
			vi.setSystemTime(start + elapsed);
			expect((await get(ctx, `${hash}.narinfo`, { env: laggedEnv })).status).toBe(404);
			expect(fetch).toHaveBeenCalledTimes(initialFetches);
			expect(withSession).toHaveBeenCalledTimes(initialReads);
		}
		// Both negative memos have expired. Even with the same stale edge
		// entry, confirmation now finds the upload and purges that entry.
		vi.setSystemTime(start + 60_000);
		const recovered = await get(ctx, `${hash}.narinfo`, { env: laggedEnv });
		expect(recovered.status).toBe(200);
		expect(await recovered.text()).toBe('local');
		expect(purged).toContain(candidateTag('path', hash));
	} finally {
		vi.useRealTimers();
		replica.sqlite.close();
	}
});

it('re-reads a stale empty NAR entry at most once per window', async () => {
	const hash = freshHash().padEnd(52, '0');
	const { ctx } = store('stale');
	const prepare = vi.spyOn(fixture.db, 'prepare');
	for (let i = 0; i < 3; i++) {
		expect((await get(ctx, `nar/${hash}.nar.zst`)).status).toBe(404);
	}
	const candidateReads = prepare.mock.calls.filter(([sql]) => /nar_hash/.test(sql));
	expect(candidateReads).toHaveLength(1);
});

it('judges staleness by the fill stamp, whatever CF-Cache-Status says', async () => {
	for (const [label, entry] of [
		['REVALIDATED', emptyEntry('stale', 'REVALIDATED')],
		['unstamped', Response.json([], { headers: { 'CF-Cache-Status': 'HIT' } })]
	] as const) {
		clearCandidateMemos();
		const hash = freshHash();
		holdLocally(hash, `nar${hash}`);
		const { ctx } = store('fresh', 'miss', { meta: entry });
		const response = await get(ctx, `${hash}.narinfo`);
		expect(response.status, label).toBe(200);
	}
});
