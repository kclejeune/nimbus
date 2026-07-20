// Mints attic-compatible JWTs (HS256) so the admin app can call the attic API
// over the service binding on behalf of a user. Mirrors the claim shape the
// attic token crate validates (namespace `https://jwt.attic.rs/v1`).

const CLAIM_NAMESPACE = 'https://jwt.attic.rs/v1';

/** Nimbus extension claims (server-wide permissions, ignored by attic verifiers). */
export const NIMBUS_CLAIM_NAMESPACE = 'https://nimbus.kclj.io/v1';

export interface GlobalClaims {
	/** may trigger garbage collection */ gc?: 1;
	/** may modify trust-affecting cache settings via the API (signing
	 * keypair, visibility) — admin-only, like gc */ ct?: 1;
}

/** Per-cache permission flags, using the attic short keys. */
export interface CachePermission {
	/** pull */ r?: 1;
	/** push */ w?: 1;
	/** delete */ d?: 1;
	/** create cache */ cc?: 1;
	/** configure cache */ cr?: 1;
	/** configure cache retention */ cq?: 1;
	/** destroy cache */ cd?: 1;
}

/** Map of cache name (or wildcard pattern) to permissions. */
export type CacheAccess = Record<string, CachePermission>;

function base64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlJson(value: unknown): string {
	return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Mint an attic JWT.
 *
 * @param secretBase64 base64-encoded HS256 secret (same one the binary-cache API validates with)
 * @param sub subject (the acting user's id)
 * @param caches the cache access map to grant
 * @param ttlSeconds token lifetime (default 5 minutes — for internal API calls)
 * @param jti optional JWT ID; set it for admin-issued tokens so they can be revoked
 */
export async function mintAtticToken(
	secretBase64: string,
	sub: string,
	caches: CacheAccess,
	ttlSeconds = 300,
	jti?: string,
	global?: GlobalClaims
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'HS256', typ: 'JWT' };
	const payload: Record<string, unknown> = {
		sub,
		iat: now,
		exp: now + ttlSeconds,
		[CLAIM_NAMESPACE]: { caches }
	};
	if (jti) payload.jti = jti;
	if (global && Object.keys(global).length > 0) payload[NIMBUS_CLAIM_NAMESPACE] = global;

	const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;

	const secret = Uint8Array.from(atob(secretBase64), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey(
		'raw',
		secret,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

	return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}
