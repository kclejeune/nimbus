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

/**
 * Verify an attic HS256 JWT and extract its cache permissions.
 * Throws on any validation failure (signature, exp/nbf, bound issuer/audience).
 */
export async function verifyAtticToken(
	token: string,
	secretBase64: string,
	bounds: { issuer?: string; audiences?: string[] } = {}
): Promise<VerifiedToken> {
	const parts = token.split('.');
	if (parts.length !== 3) throw new Error('Malformed JWT');
	const [headerB64, payloadB64, sigB64] = parts;

	const header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
	if (header.alg !== 'HS256') throw new Error(`Unsupported JWT algorithm: ${header.alg}`);

	const secret = Uint8Array.from(atob(secretBase64), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey(
		'raw',
		secret as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		base64urlDecode(sigB64) as BufferSource,
		new TextEncoder().encode(`${headerB64}.${payloadB64}`) as BufferSource
	);
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

/** Extract the bearer token from an Authorization header, if present. */
export function parseBearerToken(header: string | null): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? m[1] : null;
}
