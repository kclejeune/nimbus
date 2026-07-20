import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	allLiveUpstreams,
	clearUpstreamsMemo,
	effectiveUpstreamMode,
	findUpstreamNar,
	PERSIST_MAX_NAR_BYTES,
	probeUpstream,
	upstreamsForCache,
	VERDICT_ABSENT,
	VERDICT_PRESENT,
	VERDICT_UNPERSISTABLE,
	type Upstream
} from './missing-paths';
import { buildNarInfo } from '../attic/narinfo';
import { extractPublicKey, generateKeypair } from '../attic/signing';

/** An Upstream with defaults, for terse expectations. */
function upstream(partial: Partial<Upstream> & { url: string }): Upstream {
	return {
		id: 1,
		publicKey: null,
		ttl: null,
		mode: 'redirect',
		persistInto: null,
		nixDefault: false,
		...partial
	};
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const spy = vi.fn(handler);
	vi.stubGlobal('fetch', spy);
	return spy;
}

describe('effectiveUpstreamMode', () => {
	const entry = (default_mode: string, enforced = 0) => ({ default_mode, enforced });

	it('inherits the registry default when no override exists', () => {
		expect(effectiveUpstreamMode(entry('redirect'), undefined)).toBe('redirect');
		expect(effectiveUpstreamMode(entry('persist'), undefined)).toBe('persist');
		expect(effectiveUpstreamMode(entry('off'), undefined)).toBe('off');
	});

	it('an override row wins over the default', () => {
		expect(effectiveUpstreamMode(entry('redirect'), 'off')).toBe('off');
		expect(effectiveUpstreamMode(entry('off'), 'persist')).toBe('persist');
	});

	it('enforced entries participate at least as redirect', () => {
		expect(effectiveUpstreamMode(entry('redirect', 1), 'off')).toBe('redirect');
		expect(effectiveUpstreamMode(entry('persist', 1), 'off')).toBe('redirect');
		// persist stays a per-cache opt-in even when enforced.
		expect(effectiveUpstreamMode(entry('persist', 1), 'redirect')).toBe('redirect');
	});

	it('unknown mode strings degrade to redirect', () => {
		expect(effectiveUpstreamMode(entry('bogus'), undefined)).toBe('redirect');
		expect(effectiveUpstreamMode(entry('redirect'), 'bogus')).toBe('redirect');
	});
});

describe('probeUpstream', () => {
	afterEach(() => vi.unstubAllGlobals());

	const keyless = upstream({ url: 'https://up.example' });

	it('HEADs the narinfo when no key is configured', async () => {
		const spy = stubFetch(() => new Response(null, { status: 200 }));
		expect(await probeUpstream(keyless, 'h'.repeat(32))).toBe(VERDICT_PRESENT);
		expect(spy).toHaveBeenCalledWith(`https://up.example/${'h'.repeat(32)}.narinfo`, {
			method: 'HEAD',
			signal: expect.any(AbortSignal)
		});
	});

	it('maps 404 to absent and other statuses to no-verdict', async () => {
		stubFetch(() => new Response(null, { status: 404 }));
		expect(await probeUpstream(keyless, 'h'.repeat(32))).toBe(VERDICT_ABSENT);
		stubFetch(() => new Response(null, { status: 503 }));
		expect(await probeUpstream(keyless, 'h'.repeat(32))).toBe(null);
		stubFetch(() => {
			throw new Error('network');
		});
		expect(await probeUpstream(keyless, 'h'.repeat(32))).toBe(null);
	});

	it('probes nar: pseudo-hashes at the NAR path', async () => {
		const spy = stubFetch(() => new Response(null, { status: 200 }));
		expect(await probeUpstream(keyless, 'nar:nar/abc.nar.xz')).toBe(VERDICT_PRESENT);
		expect(spy).toHaveBeenCalledWith('https://up.example/nar/abc.nar.xz', {
			method: 'HEAD',
			signal: expect.any(AbortSignal)
		});
	});

	it('persist upstreams GET the body and mark unpersistable entries', async () => {
		const narinfo = (compression: string, narSize = 100) =>
			`StorePath: /nix/store/${'a'.repeat(32)}-foo\nURL: nar/x.nar.xz\nCompression: ${compression}\nNarHash: sha256:${'b'.repeat(64)}\nNarSize: ${narSize}\n`;
		const persist = upstream({ url: 'https://up.example', mode: 'persist' });

		stubFetch(() => new Response(narinfo('xz'), { status: 200 }));
		expect(await probeUpstream(persist, 'a'.repeat(32))).toBe(VERDICT_UNPERSISTABLE);

		stubFetch(() => new Response(narinfo('zstd'), { status: 200 }));
		expect(await probeUpstream(persist, 'a'.repeat(32))).toBe(VERDICT_PRESENT);

		stubFetch(() => new Response(narinfo('zstd', PERSIST_MAX_NAR_BYTES + 1), { status: 200 }));
		expect(await probeUpstream(persist, 'a'.repeat(32))).toBe(VERDICT_UNPERSISTABLE);
	});

	it('with a key, only a correctly signed narinfo counts as present', async () => {
		const keypair = await generateKeypair('up-1');
		const otherKeypair = await generateKeypair('up-1');
		const text = await buildNarInfo(
			{
				store_path: '/nix/store/' + 'a'.repeat(32) + '-foo',
				refs: '[]',
				system: null,
				deriver: null,
				sigs: '[]',
				ca: null
			},
			{ nar_hash: 'sha256:' + 'b'.repeat(64), nar_size: 100, compression: 'xz' },
			[],
			keypair
		);
		stubFetch(() => new Response(text, { status: 200 }));

		const keyed = upstream({ url: 'https://up.example', publicKey: extractPublicKey(keypair) });
		expect(await probeUpstream(keyed, 'a'.repeat(32))).toBe(VERDICT_PRESENT);

		const wrongKey = upstream({
			url: 'https://up.example',
			publicKey: extractPublicKey(otherKeypair)
		});
		expect(await probeUpstream(wrongKey, 'a'.repeat(32))).toBe(VERDICT_ABSENT);
	});
});

describe('findUpstreamNar verdict writes', () => {
	afterEach(() => vi.unstubAllGlobals());

	// The write-coalescing memo is module-level and outlives each test, so every
	// test probes fresh NAR paths instead of resetting shared state.
	let seq = 0;
	const freshPath = () => `nar/${(seq++).toString(36).padStart(8, '0')}.nar.xz`;

	/** A db whose reads return nothing and whose batches (verdict writes) are
	 * captured for assertions. */
	function verdictDb() {
		const batches: unknown[][] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...params: unknown[]) => ({
					sql,
					params,
					all: async () => ({ results: [] })
				})
			}),
			batch: async (stmts: unknown[]) => {
				batches.push(stmts);
				return stmts.map(() => ({ results: [] }));
			}
		} as never;
		return { db, batches };
	}

	function collectingCtx() {
		const tasks: Promise<unknown>[] = [];
		return { tasks, ctx: { waitUntil: (p: Promise<unknown>) => void tasks.push(p) } as never };
	}

	it('records a probed verdict via waitUntil and coalesces repeats', async () => {
		const { db, batches } = verdictDb();
		const { tasks, ctx } = collectingCtx();
		stubFetch(() => new Response(null, { status: 200 }));

		const path = freshPath();
		const up = [upstream({ url: 'https://up.example' })];
		expect(await findUpstreamNar(db, up, path, ctx)).toBe(`https://up.example/${path}`);
		// The write rides waitUntil, not the response path.
		expect(tasks).toHaveLength(1);
		await Promise.all(tasks);
		expect(batches).toHaveLength(1);

		// Same verdict inside the coalescing window: probed again (the fake db
		// remembers nothing) but not re-written.
		expect(await findUpstreamNar(db, up, path, ctx)).toBe(`https://up.example/${path}`);
		await Promise.all(tasks);
		expect(batches).toHaveLength(1);
	});

	it('re-records when the verdict changes despite the coalescing window', async () => {
		const { db, batches } = verdictDb();
		const { tasks, ctx } = collectingCtx();
		const path = freshPath();
		const up = [upstream({ url: 'https://up.example' })];

		stubFetch(() => new Response(null, { status: 200 }));
		expect(await findUpstreamNar(db, up, path, ctx)).toBe(`https://up.example/${path}`);
		stubFetch(() => new Response(null, { status: 404 }));
		expect(await findUpstreamNar(db, up, path, ctx)).toBe(null);
		await Promise.all(tasks);
		expect(batches).toHaveLength(2);
	});
});

describe('registry resolution', () => {
	beforeEach(clearUpstreamsMemo);

	interface RegistryFixture {
		upstreams: {
			id: number;
			url: string;
			public_key: string | null;
			ttl: number | null;
			default_mode: string;
			enforced: number;
			position: number;
		}[];
		subs: { cache_id: number; upstream_id: number; mode: string }[];
		caches: { id: number; name: string }[];
	}

	/** Answers the config loader's three-statement batch from fixtures. The
	 * upstream rows are served pre-sorted, like the SQL ORDER BY position. */
	function fakeDb(fx: RegistryFixture) {
		return {
			prepare: (sql: string) => ({ sql }),
			batch: async (stmts: { sql: string }[]) =>
				stmts.map((s) => ({
					results: s.sql.includes('FROM cache_upstream')
						? fx.subs
						: s.sql.includes('FROM upstream')
							? [...fx.upstreams].sort((a, b) => a.position - b.position || a.id - b.id)
							: fx.caches
				}))
		} as never;
	}

	const entry = (
		id: number,
		url: string,
		extra: Partial<RegistryFixture['upstreams'][number]> = {}
	) => ({
		id,
		url,
		public_key: null,
		ttl: null,
		default_mode: 'redirect',
		enforced: 0,
		position: id,
		nix_default: 0,
		...extra
	});

	it('upstreamsForCache resolves overrides, drops off, in position order', async () => {
		const db = fakeDb({
			upstreams: [
				entry(1, 'https://cachix.example', { ttl: 3600, public_key: 'c-1:KEY', position: 1 }),
				entry(2, 'https://nixos.example', { ttl: 365 * 24 * 3600, position: 0 }),
				entry(3, 'https://unused.example', { position: 2 })
			],
			subs: [
				{ cache_id: 10, upstream_id: 1, mode: 'persist' },
				{ cache_id: 10, upstream_id: 3, mode: 'off' }
			],
			caches: [{ id: 10, name: 'mine' }]
		});
		expect(await upstreamsForCache(db, { id: 10, name: 'mine' })).toEqual([
			upstream({ id: 2, url: 'https://nixos.example', ttl: 365 * 24 * 3600 }),
			upstream({
				id: 1,
				url: 'https://cachix.example',
				publicKey: 'c-1:KEY',
				ttl: 3600,
				mode: 'persist',
				persistInto: 'mine'
			})
		]);
	});

	it('enforced upstreams cannot be turned off per cache', async () => {
		const db = fakeDb({
			upstreams: [entry(1, 'https://nixos.example', { enforced: 1 })],
			subs: [{ cache_id: 10, upstream_id: 1, mode: 'off' }],
			caches: [{ id: 10, name: 'mine' }]
		});
		expect((await upstreamsForCache(db, { id: 10, name: 'mine' }))[0].mode).toBe('redirect');
	});

	it('allLiveUpstreams unions enabled entries; persistInto = first cache by order', async () => {
		const db = fakeDb({
			upstreams: [
				entry(1, 'https://a.example'),
				entry(2, 'https://b.example', { default_mode: 'off' })
			],
			subs: [
				{ cache_id: 11, upstream_id: 1, mode: 'persist' },
				{ cache_id: 10, upstream_id: 1, mode: 'persist' },
				{ cache_id: 10, upstream_id: 2, mode: 'off' }
			],
			// Already ordered by (priority, name), as the loader's query returns.
			caches: [
				{ id: 10, name: 'one' },
				{ id: 11, name: 'two' }
			]
		});
		const merged = await allLiveUpstreams(db);
		// b.example: default off and no cache enables it -> excluded entirely.
		expect(merged).toEqual([
			upstream({ id: 1, url: 'https://a.example', mode: 'persist', persistInto: 'one' })
		]);
	});

	it('memoizes per isolate until cleared', async () => {
		const first = fakeDb({
			upstreams: [entry(1, 'https://a.example')],
			subs: [],
			caches: [{ id: 10, name: 'one' }]
		});
		const second = fakeDb({ upstreams: [], subs: [], caches: [] });
		expect(await allLiveUpstreams(first)).toHaveLength(1);
		// Memo still serves the first snapshot even with a different db.
		expect(await allLiveUpstreams(second)).toHaveLength(1);
		clearUpstreamsMemo();
		expect(await allLiveUpstreams(second)).toHaveLength(0);
	});
});
