// nimbus extension endpoints for headless administration over /_api/v1:
// cache listing, token self-service, and per-path destroy. These reuse the
// dashboard's policy modules (grant resolution, mint bounding) rather than
// reimplementing them, so the CLI and the UI can never drift on what a user
// is allowed to do. Everything here must stay $lib-alias-free transitively —
// wrangler bundles this tree without SvelteKit's resolver.

import { errorResponse, jsonResponse } from '../attic/http';
import type { CachePermission } from '../attic-token';
import { NO_PERMISSION, permissionForCache, type VerifiedToken } from '../attic/token';
import { isActiveUser } from '../auth/types';
import { loadEffectiveAccess } from '../auth/permissions';
import { PERMISSION_BIT_FIELDS } from '../../permission-bits';
import { writeAudit } from '../audit';
import { isRecord, JSON_LIMITS, readJson } from '../request-body';
import {
	TOKEN_MAX_DAYS,
	TOKEN_NAME_MAX_CHARS,
	auditTokenIssue,
	boundTokenScope,
	listUserTokens,
	mintAndStore,
	revokeUserToken
} from '../tokens';
import * as db from './db';
import { detachClosure } from './gc';
import { listLiveCachesCached } from './cache-lookup';
import { type ExecutionContext } from './platform';

type Env = App.Platform['env'];

/**
 * GET /_api/v1/caches — caches the caller may discover: public ones plus any
 * the token carries an explicit bit for. Anonymous callers see public caches
 * only, mirroring read authorization (authorizeCacheRead) — this endpoint
 * must never become an enumeration oracle for private names.
 */
export async function handleCacheList(
	env: Env,
	token: VerifiedToken | null,
	admit: () => Promise<void>
): Promise<Response> {
	// Shared memo; visibility is filtered per caller below.
	const results = await listLiveCachesCached(env.ATTIC_DB, admit);

	const caches = results.flatMap((row) => {
		const perm = token ? permissionForCache(token, row.name) : { ...NO_PERMISSION };
		const isPublic = row.is_public === 1;
		if (!isPublic && !Object.values(perm).some(Boolean)) return [];
		return [
			{
				name: row.name,
				public: isPublic,
				priority: row.priority,
				compression: row.compression,
				retention_period: row.retention_period,
				retention_max_bytes: row.retention_max_bytes,
				permissions: {
					pull: perm.pull || isPublic,
					push: perm.push,
					delete: perm.delete,
					configure_cache: perm.configureCache,
					configure_cache_retention: perm.configureCacheRetention,
					destroy_cache: perm.destroyCache
				}
			}
		];
	});
	return jsonResponse({ caches });
}

interface MinterRow {
	id: string;
	role: string;
	status: string;
}

/**
 * Token self-service acts as the *user behind the presented token*, so it
 * only works for tokens with a jti recorded in api_token (dashboard- or
 * CLI-login-issued). Raw `atticadm`-style JWTs have no user to act as.
 */
async function resolveMinter(env: Env, token: VerifiedToken): Promise<MinterRow | Response> {
	if (!token.jti) {
		return errorResponse(403, 'Token self-service requires a dashboard-issued token');
	}
	const row = await db
		.readSession(env.ATTIC_DB)
		.prepare(
			`SELECT u.id AS id, u.role AS role, u.status AS status
			 FROM api_token t JOIN user u ON u.id = t.user_id WHERE t.id = ?1`
		)
		.bind(token.jti)
		.first<MinterRow>();
	if (!row) return errorResponse(403, 'Token is not associated with a user');
	if (!isActiveUser(row)) return errorResponse(403, 'Account is not active');
	return row;
}

interface TokenCreateBody {
	name?: string;
	cache?: string;
	/** Form-field permission names: pull, push, delete, configure_cache, destroy_cache. */
	permissions?: string[];
	gc?: boolean;
	ct?: boolean;
	expiry_days?: number;
}

/** Type- and size-check every token-create field before use. */
function parseTokenCreateBody(raw: unknown): TokenCreateBody | Response {
	if (!isRecord(raw)) return errorResponse(400, 'Invalid request body');
	const bad = (field: string) => errorResponse(400, `Invalid ${field}`);
	const optional = (v: unknown, type: 'string' | 'boolean') => v === undefined || typeof v === type;
	if (!optional(raw.name, 'string')) return bad('name');
	// Length is bounded by boundTokenScope.
	if (!optional(raw.cache, 'string')) return bad('cache');
	if (!optional(raw.gc, 'boolean')) return bad('gc');
	if (!optional(raw.ct, 'boolean')) return bad('ct');
	const permissions = raw.permissions;
	if (
		permissions !== undefined &&
		(!Array.isArray(permissions) ||
			permissions.length > PERMISSION_BIT_FIELDS.length ||
			!permissions.every((p) => typeof p === 'string'))
	) {
		return bad('permissions');
	}
	if (
		raw.expiry_days !== undefined &&
		(!Number.isInteger(raw.expiry_days) ||
			(raw.expiry_days as number) < 1 ||
			(raw.expiry_days as number) > TOKEN_MAX_DAYS)
	) {
		return errorResponse(400, `expiry_days must be an integer in 1..${TOKEN_MAX_DAYS}`);
	}
	return raw as TokenCreateBody;
}

/** /_api/v1/tokens: POST (mint), GET (list own), DELETE /{id} (revoke own). */
export async function handleTokensApi(
	request: Request,
	env: Env,
	token: VerifiedToken
): Promise<Response> {
	const minter = await resolveMinter(env, token);
	if (minter instanceof Response) return minter;
	const method = request.method;
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);

	if (method === 'GET' && segments.length === 3) {
		return jsonResponse({ tokens: await listUserTokens(env.ATTIC_DB, minter.id) });
	}

	if (method === 'DELETE' && segments.length === 4) {
		const id = decodeURIComponent(segments[3]);
		// Ownership is enforced by the WHERE clause in revokeUserToken; probe
		// first so a foreign or unknown id 404s instead of silently no-opping.
		const owned = await env.ATTIC_DB.prepare(
			'SELECT 1 AS x FROM api_token WHERE id = ?1 AND user_id = ?2'
		)
			.bind(id, minter.id)
			.first();
		if (!owned) return errorResponse(404, 'No such token');
		await revokeUserToken(env.ATTIC_DB, id, minter.id, minter.id);
		return jsonResponse({ revoked: id });
	}

	if (method === 'POST' && segments.length === 3) {
		const raw = await readJson(request, JSON_LIMITS.token);
		const body = parseTokenCreateBody(raw);
		if (body instanceof Response) return body;
		const name = (body.name ?? '').trim();
		if (!name || name.length > TOKEN_NAME_MAX_CHARS)
			return errorResponse(400, `Token name is required (≤${TOKEN_NAME_MAX_CHARS} chars)`);

		// Wire permission names are the token-issue form field names, mapped to
		// bits here; boundTokenScope — the single mint-bounding rule shared
		// with the dashboard — takes it from there.
		const bits: CachePermission = {};
		for (const field of body.permissions ?? []) {
			const known = PERMISSION_BIT_FIELDS.find((f) => f.field === field);
			if (!known) return errorResponse(400, `Unknown permission "${field}"`);
			bits[known.bit] = 1;
		}
		const bound = boundTokenScope(
			{
				cacheScope: body.cache ?? '*',
				bits,
				gc: !!body.gc,
				ct: !!body.ct,
				days: body.expiry_days ?? 90
			},
			{
				access: await loadEffectiveAccess(env.ATTIC_DB, minter),
				isAdmin: minter.role === 'admin'
			}
		);
		if (!bound.ok) return errorResponse(403, bound.denial);

		// Minting signs HS256; verify-only (RS256 pubkey) deployments can't.
		if (!env.JWT_HS256_SECRET_BASE64) {
			return errorResponse(500, 'Token minting requires an HS256 signing secret');
		}
		const minted = await mintAndStore(
			env.ATTIC_DB,
			env.JWT_HS256_SECRET_BASE64,
			minter.id,
			name,
			bound.scope
		);
		await auditTokenIssue(env.ATTIC_DB, minter.id, minted.jti, bound.scope, 'api');
		return jsonResponse(
			{
				id: minted.jti,
				name,
				token: minted.token,
				expires_at: minted.expiresAt,
				caches: minted.caches
			},
			201
		);
	}

	return errorResponse(404, 'Not found');
}

/**
 * DELETE /_api/v1/path/{cache}/{hash} — closure-safe per-path removal (the
 * API face of the dashboard's prune action): the path stops anchoring
 * retention immediately and is reaped once nothing else reaches it.
 */
export async function handleDestroyPath(
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheName: string,
	hash: string,
	token: VerifiedToken
): Promise<Response> {
	if (!db.STORE_PATH_HASH_RE.test(hash)) return errorResponse(400, 'Invalid store path hash');
	const permission = permissionForCache(token, cacheName);
	if (!permission.delete) return errorResponse(403, 'Permission denied: delete');
	const cache = await db.findCache(env.ATTIC_DB, cacheName);
	if (!cache) return errorResponse(404, `Cache not found: ${cacheName}`, 'NoSuchCache');

	const exists = await env.ATTIC_DB.prepare(
		'SELECT 1 AS x FROM object WHERE cache_id = ?1 AND store_path_hash = ?2'
	)
		.bind(cache.id, hash)
		.first();
	if (!exists) return errorResponse(404, 'Path not found in cache');

	const { detached, reaped } = await detachClosure(env, ctx, cache.id, cacheName, hash);
	await writeAudit(env.ATTIC_DB, {
		userId: null,
		action: 'path.destroy',
		target: `${cacheName}/${hash}`,
		detail: JSON.stringify({ sub: token.sub ?? null, via: 'api', detached, reaped })
	});
	return jsonResponse({ destroyed: hash, detached, reaped });
}
