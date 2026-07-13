// Nix's custom base32: alphabet omits e/o/u/t, digits emitted from the most
// significant bits down (reverse of RFC 4648).

const ALPHABET = '0123456789abcdfghijklmnpqrsvwxyz';

export function toNixBase32(bytes: Uint8Array): string {
	if (bytes.length === 0) return '';
	const len = Math.ceil((bytes.length * 8) / 5);
	let out = '';
	for (let n = len - 1; n >= 0; n--) {
		const b = n * 5;
		const i = b >> 3;
		const j = b & 7;
		const c = (bytes[i] >> j) | (i + 1 < bytes.length ? bytes[i + 1] << (8 - j) : 0);
		out += ALPHABET[c & 0x1f];
	}
	return out;
}

/** Decode Nix base32 (inverse of toNixBase32). Throws on invalid characters
 * or non-zero padding bits. */
export function fromNixBase32(s: string): Uint8Array {
	const size = Math.floor((s.length * 5) / 8);
	const bytes = new Uint8Array(size);
	for (let n = 0; n < s.length; n++) {
		const c = s[s.length - n - 1];
		const digit = ALPHABET.indexOf(c);
		if (digit === -1) throw new Error(`Invalid nix-base32 character: ${c}`);
		const b = n * 5;
		const i = b >> 3;
		const j = b & 7;
		bytes[i] |= (digit << j) & 0xff;
		const carry = digit >> (8 - j);
		if (i + 1 < size) bytes[i + 1] |= carry;
		else if (carry !== 0) throw new Error('Invalid nix-base32 padding');
	}
	return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NIX_BASE32_52 = /^[0-9a-df-np-sv-z]{52}$/;

/**
 * The raw hex digest of a typed sha256 hash ("sha256:<64 hex>" or
 * "sha256:<52 nix-base32>"); null for any other format. The inverse
 * normalization of convertHashToBase32.
 */
export function sha256HexDigest(hash: string): string | null {
	if (!hash.startsWith('sha256:')) return null;
	const value = hash.slice('sha256:'.length).toLowerCase();
	if (HEX64.test(value)) return value;
	if (NIX_BASE32_52.test(value)) {
		try {
			return bytesToHex(fromNixBase32(value));
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Convert a typed hash ("sha256:<64 hex>") to Nix base32 ("sha256:<52 base32>").
 * Hashes already in base32, or in any unrecognized format, pass through as-is.
 */
export function convertHashToBase32(hash: string): string {
	const colon = hash.indexOf(':');
	if (colon === -1) return hash;
	const type = hash.slice(0, colon);
	const value = hash.slice(colon + 1);
	if (value.length === 64 && /^[0-9a-fA-F]+$/.test(value)) {
		return `${type}:${toNixBase32(hexToBytes(value))}`;
	}
	return hash;
}
