// Attic JWT validation — the verify-side counterpart of $lib/server/attic-token
// (which mints). Claims live under the `https://jwt.attic.rs/v1` namespace as
// `{ caches: { "<name-or-pattern>": { r/w/d/cc/cr/cq/cd: 1 } } }`.

const CLAIM_NAMESPACE = 'https://jwt.attic.rs/v1';
const CLOCK_LEEWAY_SECONDS = 60;

export interface Permission {
	pull: boolean;
	push: boolean;
	delete: boolean;
	createCache: boolean;
	configureCache: boolean;
	configureCacheRetention: boolean;
	destroyCache: boolean;
}

export const NO_PERMISSION: Permission = {
	pull: false,
	push: false,
	delete: false,
	createCache: false,
	configureCache: false,
	configureCacheRetention: false,
	destroyCache: false
};

export interface VerifiedToken {
	sub?: string;
	jti?: string;
	/** cache name pattern -> permission */
	caches: Map<string, Permission>;
}

interface RawClaims {
	sub?: string;
	jti?: string;
	exp?: number;
	nbf?: number;
	iss?: string;
	aud?: string | string[];
	[CLAIM_NAMESPACE]?: { caches?: Record<string, Record<string, unknown>> };
}

function base64urlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function flag(v: unknown): boolean {
	return v === 1 || v === true || v === '1';
}

export interface VerifyKeys {
	hs256SecretBase64?: string;
	/** Base64 of an SPKI public key, either PEM ("BEGIN PUBLIC KEY") or raw DER. */
	rs256PubkeyBase64?: string;
}

async function importRs256Key(pubkeyBase64: string): Promise<CryptoKey> {
	let der = Uint8Array.from(atob(pubkeyBase64), (c) => c.charCodeAt(0));
	const text = new TextDecoder().decode(der);
	if (text.includes('-----BEGIN')) {
		const inner = text.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
		der = Uint8Array.from(atob(inner), (c) => c.charCodeAt(0));
	}
	return crypto.subtle.importKey(
		'spki',
		der as BufferSource,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify']
	);
}

/**
 * Verify an attic JWT (HS256 or RS256) and extract its cache permissions.
 * Throws on any validation failure (signature, exp/nbf, bound issuer/audience).
 */
export async function verifyAtticToken(
	token: string,
	keys: VerifyKeys,
	bounds: { issuer?: string; audiences?: string[] } = {}
): Promise<VerifiedToken> {
	const parts = token.split('.');
	if (parts.length !== 3) throw new Error('Malformed JWT');
	const [headerB64, payloadB64, sigB64] = parts;
	const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = base64urlDecode(sigB64);

	const header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));

	let valid: boolean;
	if (header.alg === 'HS256' && keys.hs256SecretBase64) {
		const secret = Uint8Array.from(atob(keys.hs256SecretBase64), (c) => c.charCodeAt(0));
		const key = await crypto.subtle.importKey(
			'raw',
			secret as BufferSource,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);
		valid = await crypto.subtle.verify(
			'HMAC',
			key,
			signature as BufferSource,
			signedData as BufferSource
		);
	} else if (header.alg === 'RS256' && keys.rs256PubkeyBase64) {
		const key = await importRs256Key(keys.rs256PubkeyBase64);
		valid = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			signature as BufferSource,
			signedData as BufferSource
		);
	} else {
		throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
	}
	if (!valid) throw new Error('Invalid JWT signature');

	const claims: RawClaims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));

	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.exp === 'number' && now > claims.exp + CLOCK_LEEWAY_SECONDS) {
		throw new Error('Token expired');
	}
	if (typeof claims.nbf === 'number' && now < claims.nbf - CLOCK_LEEWAY_SECONDS) {
		throw new Error('Token not yet valid');
	}
	if (bounds.issuer && claims.iss !== bounds.issuer) {
		throw new Error('Token issuer mismatch');
	}
	if (bounds.audiences?.length) {
		const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
		if (!aud.some((a) => bounds.audiences!.includes(a))) {
			throw new Error('Token audience mismatch');
		}
	}

	const caches = new Map<string, Permission>();
	for (const [pattern, p] of Object.entries(claims[CLAIM_NAMESPACE]?.caches ?? {})) {
		caches.set(pattern, {
			pull: flag(p.r),
			push: flag(p.w),
			delete: flag(p.d),
			createCache: flag(p.cc),
			configureCache: flag(p.cr),
			configureCacheRetention: flag(p.cq),
			destroyCache: flag(p.cd)
		});
	}

	return { sub: claims.sub, jti: claims.jti, caches };
}

/** Glob match with `*` (any run) and `?` (single char), like attic's wildmatch. */
export function patternMatches(pattern: string, name: string): boolean {
	if (pattern === name) return true;
	const regex = new RegExp(
		'^' +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*/g, '.*')
				.replace(/\?/g, '.') +
			'$'
	);
	return regex.test(name);
}

/** Resolve the effective permission for a cache: exact entry first, then patterns. */
export function permissionForCache(token: VerifiedToken | null, cacheName: string): Permission {
	if (!token) return { ...NO_PERMISSION };
	const direct = token.caches.get(cacheName);
	if (direct) return { ...direct };
	for (const [pattern, permission] of token.caches) {
		if (patternMatches(pattern, cacheName)) return { ...permission };
	}
	return { ...NO_PERMISSION };
}

/**
 * Extract the JWT from an Authorization header. Accepts `Bearer <jwt>` and,
 * like the reference server, `Basic <base64(user:jwt)>` with the username
 * ignored — Nix sends netrc credentials for private caches as Basic auth.
 */
export function parseAuthToken(header: string | null): string | null {
	if (!header) return null;
	const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (bearer) return bearer[1];
	const basic = /^Basic\s+(.+)$/i.exec(header.trim());
	if (basic) {
		let decoded: string;
		try {
			decoded = atob(basic[1]);
		} catch {
			return null;
		}
		const colon = decoded.indexOf(':');
		if (colon === -1) return null;
		const password = decoded.slice(colon + 1);
		return password || null;
	}
	return null;
}
