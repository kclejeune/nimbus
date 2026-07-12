// Shared addGrant/removeGrant form actions for the grant-subject detail pages
// (groups/[id], users/[id]) — identical logic, differing only in subject type.

import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { requireAdmin } from './guard';
import { parseGrantActions } from './permissions';
import { writeAudit } from '$lib/server/audit';

/** CACHE_NAME_RE widened with the attic glob characters. */
const GRANT_PATTERN_RE = /^[a-z0-9*?][a-z0-9*?-]{0,49}$/;

export function grantActions(subjectType: 'user' | 'group') {
	return {
		addGrant: async ({ request, platform, locals, params }: RequestEvent) => {
			requireAdmin(locals);
			const db = platform?.env.ATTIC_DB;
			if (!db) throw error(500, 'Database binding unavailable');
			const subjectId = params.id;
			if (!subjectId) throw error(400, 'Missing subject id');

			const form = await request.formData();
			const pattern = String(form.get('pattern') ?? '').trim();
			if (!GRANT_PATTERN_RE.test(pattern)) {
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
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
				)
				.bind(
					id,
					subjectType,
					subjectId,
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
				detail: `${subjectType}:${subjectId} ${pattern}`
			});
			return { saved: true };
		},

		removeGrant: async ({ request, platform, locals, params }: RequestEvent) => {
			requireAdmin(locals);
			const db = platform?.env.ATTIC_DB;
			if (!db) throw error(500, 'Database binding unavailable');
			const subjectId = params.id;
			if (!subjectId) throw error(400, 'Missing subject id');

			const id = String((await request.formData()).get('id') ?? '');
			await db
				.prepare(
					'DELETE FROM permission_grant WHERE id = ?1 AND subject_type = ?2 AND subject_id = ?3'
				)
				.bind(id, subjectType, subjectId)
				.run();
			await writeAudit(db, { userId: locals.user!.id, action: 'grant.delete', target: id });
			return { saved: true };
		}
	};
}
