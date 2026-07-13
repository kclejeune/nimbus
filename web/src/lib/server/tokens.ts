import type { D1Database } from '@cloudflare/workers-types';
import { mintAtticToken, type CacheAccess, type CachePermission } from './attic-token';
import { effectiveAccessOf } from './auth/guard';
import { parseTokenBits, scopeDenial } from './auth/permissions';
import { writeAudit } from './audit';

export interface TokenScope {
	/** Concrete cache name, "*", or an exact grant pattern (see scopeDenial). */
	cacheScope: string;
	/** attic permission bits to embed. */
	bits: CachePermission;
	/** Include the nimbus gc claim (admin-only; see boundTokenScope). */
	gc?: boolean;
	/** Include the nimbus ct (trust-admin) claim (admin-only): required for
	 * keypair/visibility changes over the API. */
	ct?: boolean;
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

export interface PresentedToken {
	id: string;
	name: string;
	/** JSON-encoded CacheAccess scope snapshot. */
	scope: string;
	createdAt: number;
	expiresAt: number | null;
	status: 'active' | 'expired' | 'revoked';
}

/** A user's issued tokens, presented for the token table (own-tokens page and
 *  the admin view on the user detail page). */
export async function listUserTokens(db: D1Database, userId: string): Promise<PresentedToken[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, permissions, expires_at, revoked_at, created_at
			 FROM api_token WHERE user_id = ?1 ORDER BY created_at DESC`
		)
		.bind(userId)
		.all<{
			id: string;
			name: string;
			permissions: string;
			expires_at: number | null;
			revoked_at: number | null;
			created_at: number;
		}>();
	const now = Math.floor(Date.now() / 1000);
	return results.map((t) => ({
		id: t.id,
		name: t.name,
		scope: t.permissions,
		createdAt: t.created_at,
		expiresAt: t.expires_at,
		status: t.revoked_at
			? ('revoked' as const)
			: t.expires_at && t.expires_at < now
				? ('expired' as const)
				: ('active' as const)
	}));
}

/** Revoke a token, scoped to its owner (self-service and the admin view on
 *  the user detail page share this write path). Takes effect on the next
 *  protocol request; audited against the acting user. */
export async function revokeUserToken(
	db: D1Database,
	tokenId: string,
	ownerId: string,
	actorId: string
): Promise<void> {
	await db
		.prepare('UPDATE api_token SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3')
		.bind(Math.floor(Date.now() / 1000), tokenId, ownerId)
		.run();
	await writeAudit(db, { userId: actorId, action: 'token.revoke', target: tokenId });
}

/** Lowercase hex of the SHA-256 of a string. */
export async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a token-issue form (shared by the tokens page and both CLI flows) and
 * bound it by the minting user's effective access. Returns the scope to mint,
 * or the user-facing denial.
 */
export async function boundTokenScope(
	form: FormData,
	locals: App.Locals,
	db: D1Database
): Promise<{ ok: true; scope: TokenScope } | { ok: false; denial: string }> {
	const bits = parseTokenBits(form);
	const cacheScope = String(form.get('cache') ?? '*');

	// The nimbus global claims are deliberately not per-cache grant bits: they
	// can only be minted into a token, and only by an admin. gc triggers
	// storage-wide garbage collection; ct unlocks trust-affecting cache
	// settings (keypair, visibility) over the API.
	const gc = form.get('gc') === 'on';
	const ct = form.get('ct') === 'on';
	if ((gc || ct) && locals.user?.role !== 'admin') {
		return { ok: false, denial: 'gc / trust-admin tokens are admin-only.' };
	}

	if (!(gc || ct) || Object.keys(bits).length > 0) {
		const denial = scopeDenial(await effectiveAccessOf(locals, db), { pattern: cacheScope, bits });
		if (denial) return { ok: false, denial };
	}
	return {
		ok: true,
		scope: {
			cacheScope,
			bits,
			gc,
			ct,
			days: Math.max(1, Math.min(3650, Number(form.get('expiry_days') ?? 90)))
		}
	};
}

/** The audit entry every mint route writes. */
export function auditTokenIssue(
	db: D1Database,
	userId: string,
	jti: string,
	scope: TokenScope,
	via?: string
): Promise<void> {
	return writeAudit(db, {
		userId,
		action: 'token.issue',
		target: jti,
		detail: JSON.stringify({
			scope: scope.cacheScope,
			bits: scope.bits,
			...(scope.gc && { gc: true }),
			...(scope.ct && { ct: true }),
			...(via && { via })
		})
	});
}

/** Mint a scoped, revocable attic JWT (with a jti) — no persistence. */
export async function mintScopedToken(
	secret: string,
	userId: string,
	scope: TokenScope
): Promise<MintedToken> {
	const caches: CacheAccess = { [scope.cacheScope]: { ...scope.bits } };

	const jti = crypto.randomUUID();
	const ttl = scope.days * 24 * 60 * 60;
	const global = {
		...(scope.gc && { gc: 1 as const }),
		...(scope.ct && { ct: 1 as const })
	};
	const token = await mintAtticToken(
		secret,
		userId,
		caches,
		ttl,
		jti,
		Object.keys(global).length > 0 ? global : undefined
	);
	const now = Math.floor(Date.now() / 1000);

	return { jti, token, caches, tokenHash: await sha256hex(token), expiresAt: now + ttl };
}

/** SQL to record a minted token in `api_token`. Returned as a prepared statement so
 *  callers can run it standalone or inside a batch (e.g. the device-flow approval). */
export function insertApiToken(db: D1Database, minted: MintedToken, userId: string, name: string) {
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
