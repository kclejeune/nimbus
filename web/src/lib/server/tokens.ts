import type { D1Database } from '@cloudflare/workers-types';
import { mintAtticToken, type CacheAccess, type CachePermission } from './attic-token';

export interface TokenScope {
	/** Cache name, or "*" for all caches. */
	cacheScope: string;
	canPull: boolean;
	canPush: boolean;
	/** Lifetime in days. */
	days: number;
}

export interface MintedToken {
	jti: string;
	token: string;
	caches: CacheAccess;
	tokenHash: string;
	expiresAt: number;
}

/** Lowercase hex of the SHA-256 of a string. */
export async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mint a scoped, revocable attic JWT (with a jti) — no persistence. */
export async function mintScopedToken(
	secret: string,
	userId: string,
	scope: TokenScope
): Promise<MintedToken> {
	const perm: CachePermission = {};
	if (scope.canPull) perm.r = 1;
	if (scope.canPush) perm.w = 1;
	const caches: CacheAccess = { [scope.cacheScope]: perm };

	const jti = crypto.randomUUID();
	const ttl = scope.days * 24 * 60 * 60;
	const token = await mintAtticToken(secret, userId, caches, ttl, jti);
	const now = Math.floor(Date.now() / 1000);

	return { jti, token, caches, tokenHash: await sha256hex(token), expiresAt: now + ttl };
}

/** SQL to record a minted token in `api_token`. Returned as a prepared statement so
 *  callers can run it standalone or inside a batch (e.g. the device-flow approval). */
export function insertApiToken(
	db: D1Database,
	minted: MintedToken,
	userId: string,
	name: string
) {
	return db
		.prepare(
			`INSERT INTO api_token (id, user_id, name, token_hash, permissions, expires_at, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
		)
		.bind(
			minted.jti,
			userId,
			name,
			minted.tokenHash,
			JSON.stringify(minted.caches),
			minted.expiresAt,
			Math.floor(Date.now() / 1000)
		);
}

/** Mint a scoped token and persist it. Returns the plaintext token (shown once). */
export async function mintAndStore(
	db: D1Database,
	secret: string,
	userId: string,
	name: string,
	scope: TokenScope
): Promise<MintedToken> {
	const minted = await mintScopedToken(secret, userId, scope);
	await insertApiToken(db, minted, userId, name).run();
	return minted;
}
