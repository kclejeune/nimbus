import { describe, expect, it } from 'vitest';
import { computeFingerprint, extractPublicKey, generateKeypair, signMessage } from './signing';

describe('signing', () => {
	it('generates a keypair whose public key carries the name', async () => {
		const keypair = await generateKeypair('test-1');
		expect(extractPublicKey(keypair)).toMatch(/^test-1:[A-Za-z0-9+/=]+$/);
	});

	it('signs with the keypair name prefix', async () => {
		const keypair = await generateKeypair('test-1');
		const sig = await signMessage(keypair, new TextEncoder().encode('hello'));
		expect(sig.startsWith('test-1:')).toBe(true);
	});

	it('computes the nix fingerprint format', () => {
		const fp = new TextDecoder().decode(
			computeFingerprint('/nix/store/abc-foo', 'sha256:' + 'a'.repeat(64), 123, [])
		);
		expect(fp).toMatch(/^1;\/nix\/store\/abc-foo;sha256:[0-9a-z]+;123;$/);
	});
});
