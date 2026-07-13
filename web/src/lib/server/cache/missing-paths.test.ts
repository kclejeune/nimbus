import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	allLiveUpstreams,
	clearUpstreamsMemo,
	DEFAULT_UPSTREAM_TTL_SECS,
	parseUpstreams,
	PERSIST_MAX_NAR_BYTES,
	probeUpstream,
	VERDICT_ABSENT,
	VERDICT_PRESENT,
	VERDICT_UNPERSISTABLE,
	type Upstream
} from './missing-paths';
import { buildNarInfo } from '../attic/narinfo';
import { extractPublicKey, generateKeypair } from '../attic/signing';

/** An Upstream with defaults, for terse expectations. */
function upstream(partial: Partial<Upstream> & { url: string }): Upstream {
	return { publicKey: null, ttl: null, mode: 'redirect', persistInto: null, ...partial };
}

describe('parseUpstreams', () => {
	it('parses the legacy string-array format with defaults', () => {
		expect(parseUpstreams('["https://cache.nixos.org/"]')).toEqual([
			upstream({ url: 'https://cache.nixos.org' })
		]);
	});

	it('parses full objects and mixed arrays, longest TTL first', () => {
		const raw = JSON.stringify([
			{
				url: 'https://foo.cachix.org/',
				public_key: 'foo.cachix.org-1:AAAA',
				ttl: 3600,
				mode: 'persist'
			},
			{ url: 'https://cache.nixos.org', ttl: 365 * 24 * 3600 },
			{ url: 'https://bar.example', mode: 'bogus' }
		]);
		expect(parseUpstreams(raw)).toEqual([
			upstream({ url: 'https://cache.nixos.org', ttl: 365 * 24 * 3600 }),
			upstream({ url: 'https://bar.example' }),
			upstream({
				url: 'https://foo.cachix.org',
				publicKey: 'foo.cachix.org-1:AAAA',
				ttl: 3600,
				mode: 'persist'
			})
		]);
	});

	it('sorts by TTL descending, stable among ties (default TTL)', () => {
		const raw = JSON.stringify([
			{ url: 'https://c.example', ttl: 60 },
			{ url: 'https://a.example' },
			{ url: 'https://b.example' }
		]);
		expect(parseUpstreams(raw).map((u) => u.url)).toEqual([
			'https://a.example',
			'https://b.example',
			'https://c.example'
		]);
	});

	it('tolerates malformed input', () => {
		expect(parseUpstreams(null)).toEqual([]);
		expect(parseUpstreams('not json')).toEqual([]);
		expect(parseUpstreams('{"url": "x"}')).toEqual([]);
		expect(parseUpstreams('[42, {"public_key": "k"}, ""]')).toEqual([]);
	});
});

describe('probeUpstream', () => {
	afterEach(() => vi.unstubAllGlobals());

	const keyless = upstream({ url: 'https://up.example' });

	function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
		const spy = vi.fn(handler);
		vi.stubGlobal('fetch', spy);
		return spy;
	}

	it('HEADs the narinfo when no key is configured', async () => {
		const spy = stubFetch(() => new Response(null, { status: 200 }));
		expect(await probeUpstream(keyless, 'h'.repeat(32))).toBe(VERDICT_PRESENT);
		expect(spy).toHaveBeenCalledWith(`https://up.example/${'h'.repeat(32)}.narinfo`, {
			method: 'HEAD'
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
		expect(spy).toHaveBeenCalledWith('https://up.example/nar/abc.nar.xz', { method: 'HEAD' });
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

describe('allLiveUpstreams', () => {
	beforeEach(clearUpstreamsMemo);

	function fakeDb(rows: { name: string; upstream_caches: string }[]) {
		return {
			prepare: () => ({ all: async () => ({ results: rows }) })
		} as never;
	}

	it('unions live caches, dedupes by URL, longest TTL first', async () => {
		const rows = [
			{ name: 'one', upstream_caches: '["https://a.example", "https://b.example"]' },
			{
				name: 'two',
				upstream_caches: JSON.stringify([
					'https://b.example',
					{ url: 'https://c.example', ttl: 365 * 24 * 3600 }
				])
			}
		];
		expect((await allLiveUpstreams(fakeDb(rows))).map((u) => u.url)).toEqual([
			'https://c.example',
			'https://a.example',
			'https://b.example'
		]);
	});

	it('merges strictly: keyed wins, min ttl, persistInto kept', async () => {
		const rows = [
			{ name: 'one', upstream_caches: '[{"url": "https://a.example", "ttl": 7200}]' },
			{
				name: 'two',
				upstream_caches:
					'[{"url": "https://a.example", "public_key": "a-1:KEY", "ttl": 3600, "mode": "persist"}]'
			}
		];
		expect(await allLiveUpstreams(fakeDb(rows))).toEqual([
			{
				url: 'https://a.example',
				publicKey: 'a-1:KEY',
				ttl: 3600,
				mode: 'persist',
				persistInto: 'two'
			}
		]);
	});

	it('persistInto follows the first cache wanting persistence', async () => {
		const rows = [
			{ name: 'one', upstream_caches: '[{"url": "https://a.example", "mode": "persist"}]' },
			{ name: 'two', upstream_caches: '[{"url": "https://a.example", "mode": "persist"}]' }
		];
		const [merged] = await allLiveUpstreams(fakeDb(rows));
		expect(merged.persistInto).toBe('one');
		expect(merged.ttl).toBe(DEFAULT_UPSTREAM_TTL_SECS);
	});
});
