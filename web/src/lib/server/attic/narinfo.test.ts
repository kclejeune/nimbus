import { describe, expect, it } from 'vitest';
import { buildNarInfo, narInfoSignatureValid, parseNarInfo } from './narinfo';
import { extractPublicKey, generateKeypair } from './signing';

const object = {
	store_path: '/nix/store/' + 'a'.repeat(32) + '-foo',
	refs: '[]',
	system: null,
	deriver: null,
	sigs: JSON.stringify(['upstream-key:AAAA']),
	ca: null
};
const nar = { nar_hash: 'sha256:' + 'b'.repeat(64), nar_size: 100, compression: 'zstd' };
const chunks = [{ file_hash: 'c'.repeat(64), file_size: 50 }];

describe('buildNarInfo signing', () => {
	it('signs with whichever keypair is provided (proxy re-sign path)', async () => {
		const cacheKey = await generateKeypair('cache-x');
		const proxyKey = await generateKeypair('cache.kclj.io-1');
		const asCache = await buildNarInfo(object, nar, chunks, cacheKey);
		const asProxy = await buildNarInfo(object, nar, chunks, proxyKey);
		expect(asCache).toContain('Sig: cache-x:');
		expect(asProxy).toContain('Sig: cache.kclj.io-1:');
		expect(asProxy).not.toContain('Sig: cache-x:');
		expect(asProxy).not.toContain('upstream-key');
	});
});

describe('parseNarInfo', () => {
	it('extracts the signature-relevant fields', async () => {
		const withRefs = {
			...object,
			refs: JSON.stringify(['d'.repeat(32) + '-dep', 'e'.repeat(32) + '-dep2'])
		};
		const text = await buildNarInfo(withRefs, nar, chunks, await generateKeypair('k'));
		const parsed = parseNarInfo(text);
		expect(parsed).not.toBeNull();
		expect(parsed!.storePath).toBe(object.store_path);
		expect(parsed!.narSize).toBe(100);
		expect(parsed!.narHash).toMatch(/^sha256:/);
		expect(parsed!.references).toHaveLength(2);
		expect(parsed!.sigs).toHaveLength(1);
	});

	it('returns null when fingerprint fields are missing', () => {
		expect(parseNarInfo('URL: nar/x.nar\nCompression: zstd\n')).toBeNull();
		expect(parseNarInfo('')).toBeNull();
	});
});

describe('narInfoSignatureValid', () => {
	it('round-trips: a built narinfo verifies against its own public key', async () => {
		const keypair = await generateKeypair('cache-x');
		const text = await buildNarInfo(object, nar, chunks, keypair);
		expect(await narInfoSignatureValid(text, extractPublicKey(keypair))).toBe(true);
	});

	it('rejects a narinfo signed by a different key', async () => {
		const keypair = await generateKeypair('cache-x');
		const other = await generateKeypair('cache-x');
		const text = await buildNarInfo(object, nar, chunks, keypair);
		expect(await narInfoSignatureValid(text, extractPublicKey(other))).toBe(false);
	});

	it('rejects an unsigned narinfo', async () => {
		const unsigned = await buildNarInfo({ ...object, sigs: '[]' }, nar, chunks, null);
		const keypair = await generateKeypair('cache-x');
		expect(await narInfoSignatureValid(unsigned, extractPublicKey(keypair))).toBe(false);
	});

	it('rejects a tampered narinfo (NarSize changed after signing)', async () => {
		const keypair = await generateKeypair('cache-x');
		const text = await buildNarInfo(object, nar, chunks, keypair);
		const tampered = text.replace('NarSize: 100', 'NarSize: 101');
		expect(await narInfoSignatureValid(tampered, extractPublicKey(keypair))).toBe(false);
	});
});
