// Route guards for the admin UI, mirroring requireAdmin's error style. All
// derive from EffectiveAccess so the UI and the binary-cache API agree on the
// permission vocabulary.

import { error } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import {
	canOnCache,
	loadEffectiveAccess,
	type EffectiveAccess,
	type PermissionBit
} from './permissions';

export function requireAdmin(locals: App.Locals) {
	if (!locals.user) throw error(401, 'Not signed in');
	if (locals.user.role !== 'admin') throw error(403, 'Admins only');
}

/** Subject pages: admins manage anyone; a user gets their own page. */
export function requireSelfOrAdmin(locals: App.Locals, subjectId: string) {
	if (locals.user?.id !== subjectId) requireAdmin(locals);
}

export { isActiveUser } from './types';

/** Load (once per request) the signed-in user's effective access. */
export async function effectiveAccessOf(
	locals: App.Locals,
	db: D1Database
): Promise<EffectiveAccess> {
	if (!locals.user) throw error(401, 'Not signed in');
	locals.effectiveAccess ??= await loadEffectiveAccess(db, locals.user);
	return locals.effectiveAccess;
}

/** The signed-in user as a boundTokenScope minter (every mint route). */
export async function tokenMinter(
	locals: App.Locals,
	db: D1Database
): Promise<{ access: EffectiveAccess; isAdmin: boolean }> {
	return {
		access: await effectiveAccessOf(locals, db),
		isAdmin: locals.user?.role === 'admin'
	};
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
