import { error, redirect } from '@sveltejs/kit';
import { requireSelfOrAdmin } from '$lib/server/auth/guard';
import { isActiveUser } from '$lib/server/auth/types';
import { annotateGrantMatches, grantActions } from '$lib/server/auth/grants';
import { ownerCount, userAdminActions } from '$lib/server/auth/user-admin';
import { listUserTokens, revokeUserToken } from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import { loadUserAccess } from '$lib/server/auth/user-access';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	requireSelfOrAdmin(locals, params.id);
	// A member can only be here for themselves, and /account is their view of
	// the same data (the Team section this page sits in is admin-only).
	if (locals.user!.role !== 'admin') redirect(303, '/account');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const isAdmin = locals.user!.role === 'admin';
	const [user, access, owners, cacheNames, tokens] = await Promise.all([
		db
			.prepare('SELECT id, name, email, role, is_owner, status FROM user WHERE id = ?1')
			.bind(params.id)
			.first<{
				id: string;
				name: string;
				email: string;
				role: string;
				is_owner: number;
				status: string;
			}>(),
		// Groups, direct grants, and access inherited through groups, so "what
		// can this user touch?" is answerable from this one page.
		loadUserAccess(db, params.id),
		// Only the admin-only delete button reads the owner count.
		isAdmin ? ownerCount(db) : null,
		listCacheNames(db),
		listUserTokens(db, params.id)
	]);
	if (!user) throw error(404, 'User not found');

	// Suspension mirrors isTokenDisabled in cache/db.ts: a non-active owner's
	// tokens are inert and resume on reactivation.
	const suspended = !isActiveUser(user);

	return {
		subject: {
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			isOwner: user.is_owner === 1,
			status: user.status
		},
		lastOwner: (owners ?? 0) <= 1,
		memberships: access.memberships,
		grants: annotateGrantMatches(access.grants, cacheNames),
		viaGroups: access.viaGroups,
		cacheNames,
		tokens: tokens.map((t) => ({
			...t,
			status: suspended && t.status === 'active' ? ('suspended' as const) : t.status
		}))
	};
};

export const actions: Actions = {
	// Revoke a token: admins for anyone, users for their own (the owner scope
	// pins it to this page's subject either way). Deactivation only suspends
	// tokens (they resume on reactivation); revoking is the permanent cutoff.
	revokeToken: async ({ request, platform, locals, params }) => {
		requireSelfOrAdmin(locals, params.id);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const id = String((await request.formData()).get('id') ?? '');
		await revokeUserToken(db, id, params.id, locals.user!.id);
		return { saved: true };
	},

	...grantActions('user'),
	...userAdminActions()
};
