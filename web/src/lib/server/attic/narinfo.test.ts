import { describe, expect, it } from 'vitest';
import { buildNarInfo } from './narinfo';
import { generateKeypair } from './signing';

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
