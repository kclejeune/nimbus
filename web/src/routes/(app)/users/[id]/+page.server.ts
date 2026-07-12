import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { parseGrantActions } from '$lib/server/auth/permissions';
import { writeAudit } from '$lib/server/audit';
import type { PageServerLoad, Actions } from './$types';

const PATTERN_RE = /^[a-z0-9*?][a-z0-9*?-]{0,49}$/;

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

export const actions: Actions = {
	addGrant: async ({ request, platform, locals, params }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');
		const form = await request.formData();
		const pattern = String(form.get('pattern') ?? '').trim();
		if (!PATTERN_RE.test(pattern)) {
			return fail(400, { error: 'Pattern must be a cache name or glob (*, ?).' });
		}
		const actions = parseGrantActions(form);
		if (Object.keys(actions).length === 0) {
			return fail(400, { error: 'Pick at least one permission.' });
		}
		const id = crypto.randomUUID();
		await db
			.prepare(
				`INSERT INTO permission_grant (id, subject_type, subject_id, pattern, actions, created_at, created_by)
				 VALUES (?1, 'user', ?2, ?3, ?4, ?5, ?6)`
			)
			.bind(
				id,
				params.id,
				pattern,
				JSON.stringify(actions),
				Math.floor(Date.now() / 1000),
				locals.user!.id
			)
			.run();
		await writeAudit(db, {
			userId: locals.user!.id,
			action: 'grant.create',
			target: id,
			detail: `user:${params.id} ${pattern}`
		});
		return { saved: true };
	},

	removeGrant: async ({ request, platform, locals, params }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');
		const id = String((await request.formData()).get('id') ?? '');
		await db
			.prepare(
				"DELETE FROM permission_grant WHERE id = ?1 AND subject_type = 'user' AND subject_id = ?2"
			)
			.bind(id, params.id)
			.run();
		await writeAudit(db, { userId: locals.user!.id, action: 'grant.delete', target: id });
		return { saved: true };
	}
};
