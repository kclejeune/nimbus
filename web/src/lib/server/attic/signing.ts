// Ed25519 narinfo signing in the Nix format: keypairs are stored as
// `{name}:{base64(32-byte seed || 32-byte public key)}`, signatures emitted as
// `{name}:{base64(64-byte signature)}`.

import { convertHashToBase32 } from './nix-base32';

// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410); WebCrypto can't import the
// bare 32 bytes directly.
const PKCS8_ED25519_PREFIX = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

function decodeBase64(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function decodeKeypair(keypair: string): { name: string; bytes: Uint8Array } {
	const colon = keypair.indexOf(':');
	if (colon <= 0) throw new Error('Keypair missing name separator');
	const name = keypair.slice(0, colon);
	const bytes = decodeBase64(keypair.slice(colon + 1));
	if (bytes.length !== 64) {
		throw new Error(`Invalid keypair length: expected 64, got ${bytes.length}`);
	}
	return { name, bytes };
}

/** `{name}:{base64(seed||pub)}` -> `{name}:{base64(pub)}` */
export function extractPublicKey(keypair: string): string {
	const { name, bytes } = decodeKeypair(keypair);
	return `${name}:${encodeBase64(bytes.slice(32))}`;
}

// Imported signing keys per keypair string, so a narinfo miss doesn't re-run
// base64 + PKCS#8 assembly + importKey. Isolate-lifetime; rotation stores a
// new keypair string, which simply misses this cache.
const signingKeys = new Map<string, Promise<CryptoKey>>();

function importSigningKey(keypair: string): Promise<CryptoKey> {
	let key = signingKeys.get(keypair);
	if (!key) {
		const { bytes } = decodeKeypair(keypair);
		const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
		pkcs8.set(PKCS8_ED25519_PREFIX);
		pkcs8.set(bytes.slice(0, 32), PKCS8_ED25519_PREFIX.length);
		key = crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, 'Ed25519', false, ['sign']);
		signingKeys.set(keypair, key);
		key.catch(() => signingKeys.delete(keypair));
	}
	return key;
}

/** Sign a message with a Nix-format keypair, returning `{name}:{base64 sig}`. */
export async function signMessage(keypair: string, message: Uint8Array): Promise<string> {
	// A cache hit implies a prior successful decode of this exact string, so
	// the name can be sliced without re-validating the key material.
	const key = await importSigningKey(keypair);
	const name = keypair.slice(0, keypair.indexOf(':'));
	const sig = await crypto.subtle.sign('Ed25519', key, message as BufferSource);
	return `${name}:${encodeBase64(new Uint8Array(sig))}`;
}

/** Key material of `{name}:{base64 pub}`; throws when malformed. */
function decodePublicKey(publicKey: string): Uint8Array {
	const colon = publicKey.indexOf(':');
	if (colon <= 0 || /\s/.test(publicKey)) {
		throw new Error('Public key missing name separator or contains whitespace');
	}
	const bytes = decodeBase64(publicKey.slice(colon + 1));
	if (bytes.length !== 32) {
		throw new Error(`Invalid public key length: expected 32, got ${bytes.length}`);
	}
	return bytes;
}

// Imported verify keys per public-key string, mirroring the signing-key cache.
const verifyKeys = new Map<string, Promise<CryptoKey>>();

function importVerifyKey(publicKey: string): Promise<CryptoKey> {
	let key = verifyKeys.get(publicKey);
	if (!key) {
		const bytes = decodePublicKey(publicKey);
		key = crypto.subtle.importKey('raw', bytes as BufferSource, 'Ed25519', false, ['verify']);
		verifyKeys.set(publicKey, key);
		key.catch(() => verifyKeys.delete(publicKey));
	}
	return key;
}

/** Whether `{name}:{base64 pub}` parses as a Nix public key. */
export function isValidPublicKey(publicKey: string): boolean {
	try {
		decodePublicKey(publicKey);
		return true;
	} catch {
		return false;
	}
}

/**
 * Verify a Nix signature (`{name}:{base64 sig}`) over a message with a public
 * key (`{name}:{base64 pub}`). The key names must match — a signature from a
 * different key of the same upstream proves nothing about this key.
 */
export async function verifySignature(
	publicKey: string,
	signature: string,
	message: Uint8Array
): Promise<boolean> {
	const keyName = publicKey.slice(0, publicKey.indexOf(':'));
	const sigColon = signature.indexOf(':');
	if (sigColon <= 0 || signature.slice(0, sigColon) !== keyName) return false;
	try {
		const sigBytes = decodeBase64(signature.slice(sigColon + 1));
		if (sigBytes.length !== 64) return false;
		const key = await importVerifyKey(publicKey);
		return await crypto.subtle.verify(
			'Ed25519',
			key,
			sigBytes as BufferSource,
			message as BufferSource
		);
	} catch {
		return false;
	}
}

/**
 * Nix path fingerprint: `1;{storePath};{narHash base32};{narSize};{refs}` with
 * references as comma-separated full store paths.
 */
export function computeFingerprint(
	storePath: string,
	narHash: string,
	narSize: number,
	references: string[]
): Uint8Array {
	const storeDir = storePath.includes('/')
		? storePath.slice(0, storePath.lastIndexOf('/'))
		: '/nix/store';
	const fullRefs = references.map((r) => (r.startsWith('/') ? r : `${storeDir}/${r}`));
	const fingerprint = `1;${storePath};${convertHashToBase32(narHash)};${narSize};${fullRefs.join(',')}`;
	return new TextEncoder().encode(fingerprint);
}

/** Generate a fresh Nix-format Ed25519 keypair: `{name}:{base64(seed||pub)}`. */
export async function generateKeypair(name: string): Promise<string> {
	if (!name || name.includes(':')) throw new Error('Invalid key name');
	const pair = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	const seed = pkcs8.slice(-32);
	const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const bytes = new Uint8Array(64);
	bytes.set(seed);
	bytes.set(pub, 32);
	return `${name}:${encodeBase64(bytes)}`;
}
