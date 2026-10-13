import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { persistUpstreamPath } from './pullthrough';
import { testDatabase } from './test-db';
import { buildNarInfo } from '../attic/narinfo';
import { absoluteNarinfoUrl } from '../attic/nar-url';
import { extractPublicKey, generateKeypair } from '../attic/signing';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

const fixture = testDatabase();
const env = { ATTIC_DB: fixture.db } as unknown as App.Platform['env'];
const upstreamUrl = 'https://upstream.test/cache';
let sequence = 0;
let key: string;

beforeEach(async () => {
	key = await generateKeypair('upstream');
	fixture.sqlite.exec(
		'DELETE FROM cache_upstream; DELETE FROM cache; DELETE FROM upstream_check; DELETE FROM upstream;'
	);
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'test','',1,'zstd',datetime('now'))"
	);
	fixture.sqlite
		.prepare(
			"INSERT INTO upstream (url,public_key,ttl,default_mode,enforced,position,nix_default,created_at) VALUES (?, ?, 3600, 'persist', 0, 0, 0, datetime('now'))"
		)
		.run(upstreamUrl, extractPublicKey(key));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function narinfo(url: string) {
	const hash = `pullthrough${(sequence++).toString().padStart(21, '0')}`;
	const text = await buildNarInfo(
		{
			store_path: `/nix/store/${hash}-test`,
			refs: '[]',
			sigs: '[]',
			system: null,
			deriver: null,
			ca: null
		},
		{ nar_hash: `sha256:${'c'.repeat(64)}`, nar_size: 1, compression: 'none' },
		[],
		key
	);
	return text.replace(/^URL: .*$/m, `URL: ${url}`);
}

it.each([
	['nar/x.nar', 'https://upstream.test/cache/nar/x.nar'],
	['/nar/x.nar', 'https://upstream.test/nar/x.nar'],
	['https://upstream.test/cache/nar/x.nar', 'https://upstream.test/cache/nar/x.nar'],
	['https://cdn.test/nar/x.nar', 'https://cdn.test/nar/x.nar']
])('ingests the correct download target for %s after URL rewriting', async (url, expected) => {
	const fetch = vi.fn(async (_url: string | URL | Request) => new Response(null, { status: 404 }));
	vi.stubGlobal('fetch', fetch);
	const text = absoluteNarinfoUrl(await narinfo(url), upstreamUrl);
	await persistUpstreamPath(env, undefined, 'test', upstreamUrl, text);
	expect(fetch).toHaveBeenCalledOnce();
	expect(fetch.mock.calls[0][0]).toBe(expected);
});

it('still rechecks upstream trust before downloading an absolute URL', async () => {
	const text = absoluteNarinfoUrl(await narinfo('nar/x.nar'), upstreamUrl);
	fixture.sqlite.exec('DELETE FROM upstream');
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await persistUpstreamPath(env, undefined, 'test', upstreamUrl, text);
	expect(fetch).not.toHaveBeenCalled();
});

it('never fetches an unsupported absolute URL', async () => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await persistUpstreamPath(
		env,
		undefined,
		'test',
		upstreamUrl,
		await narinfo('file:///etc/passwd')
	);
	expect(fetch).not.toHaveBeenCalled();
});
