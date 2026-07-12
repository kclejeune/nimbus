import { error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { grantActions } from '$lib/server/auth/grants';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const user = await db
		.prepare('SELECT id, name, email, role FROM user WHERE id = ?1')
		.bind(params.id)
		.first<{ id: string; name: string; email: string; role: string }>();
	if (!user) throw error(404, 'User not found');

	const [memberships, grants] = await Promise.all([
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
			.all<{ id: string; pattern: string; actions: string }>()
	]);

	return { subject: user, memberships: memberships.results, grants: grants.results };
};

export const actions: Actions = grantActions('user');
