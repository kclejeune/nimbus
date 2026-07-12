// Route guards for the admin UI, mirroring requireAdmin's error style. All
// derive from EffectiveAccess so the UI and the attic HTTP API agree on the
// permission vocabulary.

import { error } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import {
	canOnCache,
	loadEffectiveAccess,
	type EffectiveAccess,
	type PermissionBit
} from './permissions';
import type { SessionUser } from './types';

export function requireAdmin(locals: App.Locals) {
	if (!locals.user) throw error(401, 'Not signed in');
	if (locals.user.role !== 'admin') throw error(403, 'Admins only');
}

/** Admins are never locked out by activation status. */
export function isActiveUser(user: Pick<SessionUser, 'role' | 'status'>): boolean {
	return user.role === 'admin' || user.status === 'active';
}

/** For routes outside the (app) layout gate (CLI token flows). */
export function requireActive(locals: App.Locals): void {
	if (!locals.user) throw error(401, 'Not signed in');
	if (!isActiveUser(locals.user)) throw error(403, 'Account pending approval');
}

/** Load (once per request) the signed-in user's effective access. */
export async function effectiveAccessOf(
	locals: App.Locals,
	db: D1Database
): Promise<EffectiveAccess> {
	if (!locals.user) throw error(401, 'Not signed in');
	locals.effectiveAccess ??= await loadEffectiveAccess(db, locals.user);
	return locals.effectiveAccess;
}

export async function requireCachePermission(
	locals: App.Locals,
	db: D1Database,
	bit: PermissionBit,
	cacheName: string,
	label: string
): Promise<EffectiveAccess> {
	const access = await effectiveAccessOf(locals, db);
	if (!canOnCache(access, bit, cacheName)) throw error(403, `Permission denied: ${label}`);
	return access;
}

/** Any-of check — e.g. retention config accepts cq or cr. */
export async function requireAnyCachePermission(
	locals: App.Locals,
	db: D1Database,
	bits: PermissionBit[],
	cacheName: string,
	label: string
): Promise<EffectiveAccess> {
	const access = await effectiveAccessOf(locals, db);
	if (!bits.some((bit) => canOnCache(access, bit, cacheName))) {
		throw error(403, `Permission denied: ${label}`);
	}
	return access;
}
