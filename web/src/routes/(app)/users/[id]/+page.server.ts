import { error } from '@sveltejs/kit';
import { requireSelfOrAdmin } from '$lib/server/auth/guard';
import { isActiveUser } from '$lib/server/auth/types';
import { annotateGrantMatches, grantActions } from '$lib/server/auth/grants';
import { ownerCount, userAdminActions } from '$lib/server/auth/user-admin';
import { listUserTokens, revokeUserToken } from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	requireSelfOrAdmin(locals, params.id);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const isAdmin = locals.user!.role === 'admin';
	const [user, memberships, grants, viaGroups, owners, cacheNames, tokens] = await Promise.all([
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
		db
			.prepare(
				`SELECT g.id, g.name, m.source FROM group_member m
				 JOIN groups g ON g.id = m.group_id WHERE m.user_id = ?1 ORDER BY g.name`
			)
			.bind(params.id)
			.all<{ id: string; name: string; source: string }>(),
		db
			.prepare(
				`SELECT id, pattern, actions FROM permission_grant
				 WHERE subject_type = 'user' AND subject_id = ?1 ORDER BY pattern`
			)
			.bind(params.id)
			.all<{ id: string; pattern: string; actions: string }>(),
		// Access inherited through group membership, shown read-only so "what
		// can this user touch?" is answerable from this one page.
		db
			.prepare(
				`SELECT pg.id, pg.pattern, pg.actions, gr.id AS group_id, gr.name AS group_name
				 FROM permission_grant pg
				 JOIN group_member m ON m.group_id = pg.subject_id AND m.user_id = ?1
				 JOIN groups gr ON gr.id = pg.subject_id
				 WHERE pg.subject_type = 'group'
				 ORDER BY pg.pattern, gr.name`
			)
			.bind(params.id)
			.all<{
				id: string;
				pattern: string;
				actions: string;
				group_id: string;
				group_name: string;
			}>(),
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
		memberships: memberships.results,
		grants: annotateGrantMatches(grants.results, cacheNames),
		viaGroups: viaGroups.results,
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
