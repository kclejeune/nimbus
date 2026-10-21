import { expect, it } from 'vitest';
import { absoluteNarinfoUrl, resolveNarUrl } from './nar-url';
import { buildNarInfo, narInfoSignatureValid } from './narinfo';
import { extractPublicKey, generateKeypair } from './signing';

it.each([
	['nar/x.nar.zst', 'https://upstream.test/cache/nar/x.nar.zst'],
	['/nar/x.nar?download=1', 'https://upstream.test/nar/x.nar?download=1'],
	['../nar/x.nar', 'https://upstream.test/nar/x.nar'],
	['https://cdn.test/x.nar', 'https://cdn.test/x.nar'],
	['//cdn.test/x.nar', 'https://cdn.test/x.nar']
])('resolves %s consistently for Nix and ingestion', (value, expected) => {
	expect(resolveNarUrl('https://upstream.test/cache/', value)).toBe(expected);
	expect(absoluteNarinfoUrl(`URL: ${value}\nSig: untouched\n`, 'https://upstream.test/cache')).toBe(
		`URL: ${expected}\nSig: untouched\n`
	);
});

it.each([
	'file:///etc/passwd',
	'data:text/plain,hello',
	'http://cdn.test/x',
	'https://user:password@cdn.test/x',
	'https://127.0.0.1/x'
])('refuses unsupported download targets: %s', (url) => {
	expect(resolveNarUrl('https://upstream.test', url)).toBeNull();
	expect(absoluteNarinfoUrl(`URL: ${url}\n`, 'https://upstream.test')).toBe(`URL: ${url}\n`);
});

it('preserves CRLF and all signed fields', () => {
	expect(absoluteNarinfoUrl('URL: nar/x\r\nSig: exact\r\n', 'https://upstream.test')).toBe(
		'URL: https://upstream.test/nar/x\r\nSig: exact\r\n'
	);
});

it('retains a valid upstream signature after rewriting its download URL', async () => {
	const key = await generateKeypair('upstream');
	const original = await buildNarInfo(
		{
			store_path: `/nix/store/${'a'.repeat(32)}-test`,
			refs: '[]',
			sigs: '[]',
			system: null,
			deriver: null,
			ca: null
		},
		{ nar_hash: `sha256:${'b'.repeat(64)}`, nar_size: 100, compression: 'zstd' },
		[{ file_hash: 'c'.repeat(64), file_size: 50 }],
		key
	);
	const rewritten = absoluteNarinfoUrl(original, 'https://upstream.test/cache');
	expect(rewritten).toContain('URL: https://upstream.test/cache/nar/');
	expect(await narInfoSignatureValid(rewritten, extractPublicKey(key))).toBe(true);
	expect(rewritten.split('\n').filter((line) => !line.startsWith('URL:'))).toEqual(
		original.split('\n').filter((line) => !line.startsWith('URL:'))
	);
});
