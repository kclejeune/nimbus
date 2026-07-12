import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { grantActions } from '$lib/server/auth/grants';
import { writeAudit } from '$lib/server/audit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals, params }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const group = await db
		.prepare('SELECT id, name, description, oidc_group FROM groups WHERE id = ?1')
		.bind(params.id)
		.first<{ id: string; name: string; description: string | null; oidc_group: string | null }>();
	if (!group) throw error(404, 'Group not found');

	const [members, grants, users] = await Promise.all([
		db
			.prepare(
				`SELECT u.id, u.name, u.email, m.source FROM group_member m
				 JOIN user u ON u.id = m.user_id WHERE m.group_id = ?1 ORDER BY u.name`
			)
			.bind(params.id)
			.all<{ id: string; name: string; email: string; source: string }>(),
		db
			.prepare(
				`SELECT id, pattern, actions FROM permission_grant
				 WHERE subject_type = 'group' AND subject_id = ?1 ORDER BY pattern`
			)
			.bind(params.id)
			.all<{ id: string; pattern: string; actions: string }>(),
		db
			.prepare('SELECT id, name, email FROM user ORDER BY name')
			.all<{ id: string; name: string; email: string }>()
	]);

	return {
		group: {
			id: group.id,
			name: group.name,
			description: group.description,
			oidcGroup: group.oidc_group
		},
		members: members.results,
		grants: grants.results,
		allUsers: users.results
	};
};

export const actions: Actions = {
	setMapping: async ({ request, platform, locals, params }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');
		const value = String((await request.formData()).get('oidc_group') ?? '').trim() || null;
		await db
			.prepare('UPDATE groups SET oidc_group = ?1 WHERE id = ?2')
			.bind(value, params.id)
			.run();
		await writeAudit(db, {
			userId: locals.user!.id,
			action: 'group.mapping',
			target: params.id,
			detail: value ?? ''
		});
		return { saved: true };
	},

	addMember: async ({ request, platform, locals, params }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');
		const userId = String((await request.formData()).get('user_id') ?? '');
		if (!userId) return fail(400, { error: 'Pick a user.' });
		await db
			.prepare(
				`INSERT OR REPLACE INTO group_member (group_id, user_id, source, created_at)
				 VALUES (?1, ?2, 'manual', ?3)`
			)
			.bind(params.id, userId, Math.floor(Date.now() / 1000))
			.run();
		await writeAudit(db, {
			userId: locals.user!.id,
			action: 'group.member.add',
			target: params.id,
			detail: userId
		});
		return { saved: true };
	},

	removeMember: async ({ request, platform, locals, params }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');
		const userId = String((await request.formData()).get('user_id') ?? '');
		await db
			.prepare('DELETE FROM group_member WHERE group_id = ?1 AND user_id = ?2')
			.bind(params.id, userId)
			.run();
		await writeAudit(db, {
			userId: locals.user!.id,
			action: 'group.member.remove',
			target: params.id,
			detail: userId
		});
		return { saved: true };
	},

	...grantActions('group')
};
