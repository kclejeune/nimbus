import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import type { PageServerLoad, Actions } from './$types';

interface GroupListRow {
	id: string;
	name: string;
	description: string | null;
	oidc_group: string | null;
	members: number;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const { results } = await db
		.prepare(
			`SELECT g.id, g.name, g.description, g.oidc_group, COUNT(m.user_id) AS members
			 FROM groups g LEFT JOIN group_member m ON m.group_id = g.id
			 GROUP BY g.id ORDER BY g.name`
		)
		.all<GroupListRow>();

	return {
		groups: results.map((g) => ({
			id: g.id,
			name: g.name,
			description: g.description,
			oidcGroup: g.oidc_group,
			members: g.members
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, platform, locals }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const description = String(form.get('description') ?? '').trim() || null;
		if (!name) return fail(400, { error: 'Give the group a name.' });

		const id = crypto.randomUUID();
		try {
			await db
				.prepare('INSERT INTO groups (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)')
				.bind(id, name, description, Math.floor(Date.now() / 1000))
				.run();
		} catch {
			return fail(409, { error: `A group named "${name}" already exists.` });
		}
		await writeAudit(db, {
			userId: locals.user!.id,
			action: 'group.create',
			target: id,
			detail: name
		});
		return { created: true };
	},

	delete: async ({ request, platform, locals }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const id = String((await request.formData()).get('id') ?? '');
		// Grants have no cross-type FK; delete them with the group atomically.
		await db.batch([
			db
				.prepare("DELETE FROM permission_grant WHERE subject_type = 'group' AND subject_id = ?1")
				.bind(id),
			db.prepare('DELETE FROM groups WHERE id = ?1').bind(id)
		]);
		await writeAudit(db, { userId: locals.user!.id, action: 'group.delete', target: id });
		return { deleted: true };
	}
};
