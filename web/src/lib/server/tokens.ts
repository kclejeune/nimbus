import type { D1Database } from '@cloudflare/workers-types';
import { mintAtticToken, type CacheAccess, type CachePermission } from './attic-token';
import { parseTokenBits, scopeDenial, type EffectiveAccess } from './auth/permissions';
import { writeAudit } from './audit';
import { isActiveUser } from './auth/types';
import { assertMaxLength } from './request-body';

export const TOKEN_NAME_MAX_CHARS = 100;
export const TOKEN_SCOPE_MAX_CHARS = 128;
export const TOKEN_MAX_DAYS = 3650;

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
		status: tokenStatus(t, now)
	}));
}

/** Revoked beats expired beats active; `now` in unix seconds. */
function tokenStatus(
	t: { revoked_at: number | null; expires_at: number | null },
	now: number
): PresentedToken['status'] {
	if (t.revoked_at) return 'revoked';
	return t.expires_at && t.expires_at < now ? 'expired' : 'active';
}

/** Rows shown per page of the admin all-tokens view. */
export const ALL_TOKENS_PAGE_SIZE = 50;

export interface OwnedToken extends Omit<PresentedToken, 'status'> {
	/** 'suspended': valid but inert while the owner is deactivated (mirrors
	 *  isTokenDisabled in cache/db.ts). */
	status: PresentedToken['status'] | 'suspended';
	owner: { id: string; name: string; email: string };
}

/** Every user's tokens, newest first, one page at a time (admin view). Fetches
 *  one extra row to report `hasMore` without a COUNT scan. */
export async function listAllTokens(
	db: D1Database,
	{ limit = ALL_TOKENS_PAGE_SIZE, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<{ tokens: OwnedToken[]; hasMore: boolean }> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.name, t.permissions, t.expires_at, t.revoked_at, t.created_at,
			        u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
			        u.role AS owner_role, u.status AS owner_status
			 FROM api_token t JOIN user u ON u.id = t.user_id
			 ORDER BY t.created_at DESC, t.id
			 LIMIT ?1 OFFSET ?2`
		)
		.bind(limit + 1, offset)
		.all<{
			id: string;
			name: string;
			permissions: string;
			expires_at: number | null;
			revoked_at: number | null;
			created_at: number;
			owner_id: string;
			owner_name: string;
			owner_email: string;
			owner_role: string;
			owner_status: string;
		}>();
	const now = Math.floor(Date.now() / 1000);
	const tokens = results.slice(0, limit).map((t) => {
		const base = tokenStatus(t, now);
		const ownerActive = isActiveUser({ role: t.owner_role, status: t.owner_status });
		return {
			id: t.id,
			name: t.name,
			scope: t.permissions,
			createdAt: t.created_at,
			expiresAt: t.expires_at,
			status: base === 'active' && !ownerActive ? ('suspended' as const) : base,
			owner: { id: t.owner_id, name: t.owner_name, email: t.owner_email }
		};
	});
	return { tokens, hasMore: results.length > limit };
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

/** Tombstone a user's token ids; batch it with deleting their api_token rows
 *  (see deleteUser in auth/user-admin.ts). */
export function tombstoneUserTokens(
	db: D1Database,
	userId: string,
	reason: string,
	nowSeconds = Math.floor(Date.now() / 1000)
) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO revoked_token (jti, expires_at, revoked_at, reason)
			 SELECT id, expires_at, ?2, ?3 FROM api_token WHERE user_id = ?1`
		)
		.bind(userId, nowSeconds, reason);
}

/** Lowercase hex of the SHA-256 of a string. */
export async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A mint request in transport-neutral shape (see parseTokenForm for the
 *  HTML-form decoding; the JSON token API builds one directly). */
export interface TokenRequest {
	cacheScope: string;
	bits: CachePermission;
	gc: boolean;
	ct: boolean;
	days: number;
}

/** Token-issue form -> TokenRequest (the tokens page and both CLI flows). */
export function parseTokenForm(form: FormData): TokenRequest {
	return {
		cacheScope: String(form.get('cache') ?? '*'),
		bits: parseTokenBits(form),
		gc: form.get('gc') === 'on',
		ct: form.get('ct') === 'on',
		days: Number(form.get('expiry_days') ?? 90)
	};
}

/**
 * Bound a mint request by the minting user's effective access. Returns the
 * scope to mint, or the user-facing denial. Transport-agnostic (structured
 * request + resolved access, not FormData/locals) so the cache worker's token
 * API (v1-admin.ts) shares the exact bounding rule with the dashboard.
 */
export function boundTokenScope(
	request: TokenRequest,
	minter: { access: EffectiveAccess; isAdmin: boolean }
): { ok: true; scope: TokenScope } | { ok: false; denial: string } {
	const { cacheScope, bits, gc, ct } = request;
	if (cacheScope.length > TOKEN_SCOPE_MAX_CHARS) {
		return { ok: false, denial: `Cache scope exceeds ${TOKEN_SCOPE_MAX_CHARS} characters.` };
	}

	// The nimbus global claims are deliberately not per-cache grant bits: they
	// can only be minted into a token, and only by an admin. gc triggers
	// storage-wide garbage collection; ct unlocks trust-affecting cache
	// settings (keypair, visibility) over the API.
	if ((gc || ct) && !minter.isAdmin) {
		return { ok: false, denial: 'gc / trust-admin tokens are admin-only.' };
	}

	if (!(gc || ct) || Object.keys(bits).length > 0) {
		const denial = scopeDenial(minter.access, { pattern: cacheScope, bits });
		if (denial) return { ok: false, denial };
	}
	const days = Number.isFinite(request.days)
		? Math.max(1, Math.min(TOKEN_MAX_DAYS, request.days))
		: 90;
	return { ok: true, scope: { cacheScope, bits, gc, ct, days } };
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
	assertMaxLength('Token name', name, TOKEN_NAME_MAX_CHARS);
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
