// Effective-access resolution for the fine-grained permission model. Grants
// (permission_grant rows) union into one CacheAccess map. Server-side checks
// OR every matching pattern — deliberately wider than attic's exact-match-wins
// rule, which still governs token *claims* (permissionForCache) unchanged.

import type { D1Database } from '@cloudflare/workers-types';
import type { CacheAccess, CachePermission } from '$lib/server/attic-token';
import { patternMatches } from '$lib/server/attic/token';
import {
	ALL_PERMISSION_BITS,
	PERMISSION_BIT_FIELDS,
	type PermissionBit
} from '$lib/permission-bits';

export type { PermissionBit };
/** Every recognized bit, for union/parse (grants/tokens may carry attic bits
 *  the UI no longer offers, e.g. cc/cq). */
export const PERMISSION_BITS: PermissionBit[] = ALL_PERMISSION_BITS;
export const ALL_BITS: CachePermission = { r: 1, w: 1, d: 1, cc: 1, cr: 1, cq: 1, cd: 1 };
/** Bits that make a user "see" a cache in the dashboard — a relationship with
 *  this existing cache. Excludes cc (create-anywhere is not per-cache). */
const VISIBILITY_BITS: PermissionBit[] = ['r', 'w', 'd', 'cr', 'cq', 'cd'];

/** Stored grant actions: the attic bits plus the global gc bit. */
export type GrantActions = CachePermission & { gc?: 1 };

export interface EffectiveAccess {
	caches: CacheAccess;
	gc: boolean;
}

export const ADMIN_ACCESS: EffectiveAccess = { caches: { '*': ALL_BITS }, gc: true };

export interface GrantRow {
	pattern: string;
	/** JSON-encoded GrantActions. */
	actions: string;
}

export function unionAccess(grants: GrantRow[]): EffectiveAccess {
	const caches: CacheAccess = {};
	let gc = false;
	for (const grant of grants) {
		let actions: GrantActions;
		try {
			actions = JSON.parse(grant.actions);
		} catch {
			continue;
		}
		if (actions.gc === 1) gc = true;
		const entry = (caches[grant.pattern] ??= {});
		for (const bit of PERMISSION_BITS) {
			if (actions[bit] === 1) entry[bit] = 1;
		}
	}
	return { caches, gc };
}

/** OR across the exact entry and every glob entry matching the name. */
export function canOnCache(
	access: EffectiveAccess,
	bit: PermissionBit,
	cacheName: string
): boolean {
	for (const [pattern, perm] of Object.entries(access.caches)) {
		if (perm[bit] === 1 && patternMatches(pattern, cacheName)) return true;
	}
	return false;
}

/**
 * Dashboard visibility: any granted bit on the cache. Public visibility on
 * the *protocol* (anonymous pulls) deliberately does not imply dashboard
 * visibility — the cache table only shows caches the user was granted.
 */
export function canSeeCache(access: EffectiveAccess, cacheName: string): boolean {
	return VISIBILITY_BITS.some((bit) => canOnCache(access, bit, cacheName));
}

export interface RequestedScope {
	pattern: string;
	bits: CachePermission;
	gc?: boolean;
}

/**
 * Mint-time bounding: a token may only carry what the minting user holds.
 * Wildcard scopes must exactly match a grant pattern (or be widened by a `*`
 * grant) — no general glob-subset inference. Returns null when allowed, or a
 * user-facing reason.
 */
export function scopeDenial(access: EffectiveAccess, scope: RequestedScope): string | null {
	if (scope.gc && !access.gc) return 'You do not have garbage collection permission.';
	const requested = PERMISSION_BITS.filter((bit) => scope.bits[bit] === 1);
	if (requested.length === 0 && !scope.gc) return 'Grant at least one permission.';

	if (!/[*?]/.test(scope.pattern)) {
		for (const bit of requested) {
			if (!canOnCache(access, bit, scope.pattern)) {
				return `You do not have "${bit}" on ${scope.pattern}.`;
			}
		}
		return null;
	}

	const sources = [access.caches[scope.pattern]];
	if (scope.pattern !== '*') sources.push(access.caches['*']);
	for (const bit of requested) {
		if (!sources.some((s) => s?.[bit] === 1)) {
			return `You do not have "${bit}" on the pattern ${scope.pattern}.`;
		}
	}
	return null;
}

export interface ScopeOption {
	value: string;
	bits: CachePermission;
}

/**
 * What the token scope picker offers: the user's grant patterns (with bits
 * widened by any `*` grant) plus concrete cache names covered by any bit.
 */
export function tokenScopeOptions(access: EffectiveAccess, cacheNames: string[]): ScopeOption[] {
	const options = new Map<string, CachePermission>();
	const star = access.caches['*'];
	for (const [pattern, perm] of Object.entries(access.caches)) {
		const bits: CachePermission = {};
		for (const bit of PERMISSION_BITS) {
			if (perm[bit] === 1 || (pattern !== '*' && star?.[bit] === 1)) bits[bit] = 1;
		}
		if (Object.keys(bits).length > 0) options.set(pattern, bits);
	}
	for (const name of cacheNames) {
		if (options.has(name)) continue;
		const bits: CachePermission = {};
		for (const bit of PERMISSION_BITS) {
			if (canOnCache(access, bit, name)) bits[bit] = 1;
		}
		if (Object.keys(bits).length > 0) options.set(name, bits);
	}
	return [...options.entries()]
		.map(([value, bits]) => ({ value, bits }))
		.sort((a, b) => a.value.localeCompare(b.value));
}

export interface CacheGrantRow {
	id: string;
	subject_type: string;
	subject_id: string;
	pattern: string;
	actions: string;
}

/**
 * Split a cache's applicable grants: exact-name rows (editable from the cache
 * page) vs glob rows that happen to match (shown read-only — editing them
 * would affect other caches). Non-matching rows are dropped.
 */
export function partitionCacheGrants(
	grants: CacheGrantRow[],
	cacheName: string
): { direct: CacheGrantRow[]; viaPatterns: CacheGrantRow[] } {
	const direct: CacheGrantRow[] = [];
	const viaPatterns: CacheGrantRow[] = [];
	for (const grant of grants) {
		if (grant.pattern === cacheName) direct.push(grant);
		else if (patternMatches(grant.pattern, cacheName)) viaPatterns.push(grant);
	}
	return { direct, viaPatterns };
}

/** Union of the user's direct grants and their groups' grants. Admins bypass. */
export async function loadEffectiveAccess(
	db: D1Database,
	user: { id: string; role: string }
): Promise<EffectiveAccess> {
	if (user.role === 'admin') return ADMIN_ACCESS;
	const { results } = await db
		.prepare(
			`SELECT pattern, actions FROM permission_grant
			 WHERE (subject_type = 'user' AND subject_id = ?1)
			    OR (subject_type = 'group' AND subject_id IN
			        (SELECT group_id FROM group_member WHERE user_id = ?1))`
		)
		.bind(user.id)
		.all<GrantRow>();
	return unionAccess(results);
}

/** Grant-editor form checkboxes -> GrantActions (shared by group/user pages).
 *  Only per-cache bits are grantable; gc is admin-only and never granted. */
export function parseGrantActions(form: FormData): GrantActions {
	const actions: GrantActions = {};
	for (const bit of PERMISSION_BITS) if (form.get(bit) === 'on') actions[bit] = 1;
	return actions;
}

/** Token-issue form checkboxes -> permission bits (shared by all mint routes). */
export function parseTokenBits(form: FormData): CachePermission {
	const bits: CachePermission = {};
	for (const { bit, field } of PERMISSION_BIT_FIELDS) {
		if (form.get(field) === 'on') bits[bit] = 1;
	}
	return bits;
}
