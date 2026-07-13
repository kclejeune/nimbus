import { describe, expect, it } from 'vitest';
import { bytesToHex, fromNixBase32, hexToBytes, sha256HexDigest, toNixBase32 } from './nix-base32';

describe('fromNixBase32', () => {
	it('round-trips a sha256 digest', () => {
		const hex = 'a'.repeat(64);
		const b32 = toNixBase32(hexToBytes(hex));
		expect(b32).toHaveLength(52);
		expect(bytesToHex(fromNixBase32(b32))).toBe(hex);
	});

	it('round-trips random-ish bytes', () => {
		const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
		expect([...fromNixBase32(toNixBase32(bytes))]).toEqual([...bytes]);
	});

	it('rejects invalid characters and bad padding', () => {
		expect(() => fromNixBase32('has-einvalid!')).toThrow();
		// 'z' (31) in the top digit of a 52-char sha256 hash overflows the
		// 256-bit value: valid encodings never carry bits there.
		expect(() => fromNixBase32('z' + '0'.repeat(51))).toThrow();
	});
});

describe('sha256HexDigest', () => {
	it('accepts hex and base32 sha256 hashes, normalizing to hex', () => {
		const hex = 'ab'.repeat(32);
		expect(sha256HexDigest(`sha256:${hex}`)).toBe(hex);
		expect(sha256HexDigest(`sha256:${toNixBase32(hexToBytes(hex))}`)).toBe(hex);
	});

	it('rejects other formats', () => {
		expect(sha256HexDigest('ab'.repeat(32))).toBe(null); // untyped
		expect(sha256HexDigest('sha512:' + 'ab'.repeat(32))).toBe(null);
		expect(sha256HexDigest('sha256:tooshort')).toBe(null);
	});
});
