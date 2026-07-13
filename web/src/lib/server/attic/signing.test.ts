import { describe, expect, it } from 'vitest';
import {
	computeFingerprint,
	extractPublicKey,
	generateKeypair,
	isValidPublicKey,
	signMessage,
	verifySignature
} from './signing';

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

describe('verifySignature', () => {
	const message = new TextEncoder().encode('fingerprint');

	it('accepts a signature from the matching keypair', async () => {
		const keypair = await generateKeypair('test-1');
		const sig = await signMessage(keypair, message);
		expect(await verifySignature(extractPublicKey(keypair), sig, message)).toBe(true);
	});

	it('rejects a signature from a different key', async () => {
		const signer = await generateKeypair('test-1');
		const other = await generateKeypair('test-1');
		const sig = await signMessage(signer, message);
		expect(await verifySignature(extractPublicKey(other), sig, message)).toBe(false);
	});

	it('rejects a signature over a different message', async () => {
		const keypair = await generateKeypair('test-1');
		const sig = await signMessage(keypair, message);
		expect(
			await verifySignature(extractPublicKey(keypair), sig, new TextEncoder().encode('other'))
		).toBe(false);
	});

	it('rejects a key-name mismatch even with valid key material', async () => {
		const keypair = await generateKeypair('test-1');
		const sig = await signMessage(keypair, message);
		const renamed = `other-name:${extractPublicKey(keypair).split(':')[1]}`;
		expect(await verifySignature(renamed, sig, message)).toBe(false);
	});

	it('rejects malformed signatures without throwing', async () => {
		const keypair = await generateKeypair('test-1');
		const pub = extractPublicKey(keypair);
		expect(await verifySignature(pub, 'test-1:!!!not-base64!!!', message)).toBe(false);
		expect(await verifySignature(pub, 'test-1:' + btoa('short'), message)).toBe(false);
		expect(await verifySignature(pub, 'no-separator', message)).toBe(false);
	});
});

describe('isValidPublicKey', () => {
	it('accepts a generated public key', async () => {
		expect(isValidPublicKey(extractPublicKey(await generateKeypair('k')))).toBe(true);
	});

	it('rejects malformed keys', () => {
		expect(isValidPublicKey('')).toBe(false);
		expect(isValidPublicKey('no-separator')).toBe(false);
		expect(isValidPublicKey(':' + btoa('x'.repeat(32)))).toBe(false);
		expect(isValidPublicKey('name:!!!')).toBe(false);
		expect(isValidPublicKey('name:' + btoa('too-short'))).toBe(false);
	});
});
