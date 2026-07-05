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

export function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
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
