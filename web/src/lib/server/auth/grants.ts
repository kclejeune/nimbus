// Grant-row helpers and the shared addGrant/removeGrant form actions for the
// grant-subject detail pages (groups/[id], users/[id]) — identical logic,
// differing only in subject type. The cache settings page and cache-config's
// creator auto-grant reuse the row helpers.

import { error, fail, type RequestEvent } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import type { CachePermission } from '$lib/server/attic-token';
import { patternMatches } from '$lib/server/attic/token';
import { requireAdmin } from './guard';
import { parseGrantActions } from './permissions';
import { writeAudit } from '$lib/server/audit';

/** CACHE_NAME_RE widened with the attic glob characters. */
const GRANT_PATTERN_RE = /^[a-z0-9*?][a-z0-9*?-]{0,49}$/;

/** Everything an owner needs on an existing cache. `cr` (Configure) already
 *  covers retention server-side, so cq is unnecessary; cc (create-anywhere)
 *  and gc (storage-wide) are not per-cache and excluded. */
export const FULL_CONTROL: CachePermission = { r: 1, w: 1, d: 1, cr: 1, cd: 1 };

export type SubjectType = 'user' | 'group';

/** Form-value encoding of a grant subject. The id may itself contain colons
 *  (e.g. "cfaccess:<sub>"), so decode splits on the FIRST colon only — keep
 *  compose and parse paired here. */
export function encodeSubject(type: SubjectType, id: string): string {
	return `${type}:${id}`;
}

export function decodeSubject(value: string): { type: SubjectType; id: string } | null {
	const sep = value.indexOf(':');
	if (sep === -1) return null;
	const type = value.slice(0, sep);
	const id = value.slice(sep + 1);
	return (type === 'user' || type === 'group') && id ? { type, id } : null;
}

/** Annotate grant rows with how many existing caches each pattern currently
 *  applies to, so the UI can link exact matches and warn on typo'd patterns
 *  that grant nothing. */
export function annotateGrantMatches<T extends { pattern: string }>(
	grants: T[],
	cacheNames: string[]
): (T & { matches: number })[] {
	return grants.map((g) => ({
		...g,
		matches: cacheNames.filter((name) => patternMatches(g.pattern, name)).length
	}));
}

export interface NewGrant {
	subjectType: SubjectType;
	subjectId: string;
	pattern: string;
	actions: CachePermission;
	actorId: string | null;
	detail?: string;
}

/** Insert a grant row + audit entry; returns the new grant id. */
export async function insertGrant(db: D1Database, grant: NewGrant): Promise<string> {
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO permission_grant (id, subject_type, subject_id, pattern, actions, created_at, created_by)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
		)
		.bind(
			id,
			grant.subjectType,
			grant.subjectId,
			grant.pattern,
			JSON.stringify(grant.actions),
			Math.floor(Date.now() / 1000),
			grant.actorId
		)
		.run();
	await writeAudit(db, {
		userId: grant.actorId,
		action: 'grant.create',
		target: id,
		detail: grant.detail ?? `${grant.subjectType}:${grant.subjectId} ${grant.pattern}`
	});
	return id;
}

/** Delete a grant row (scoped to its subject) + audit entry. */
export async function removeGrantRow(
	db: D1Database,
	id: string,
	subjectType: SubjectType,
	subjectId: string,
	actorId: string | null
): Promise<void> {
	await db
		.prepare('DELETE FROM permission_grant WHERE id = ?1 AND subject_type = ?2 AND subject_id = ?3')
		.bind(id, subjectType, subjectId)
		.run();
	await writeAudit(db, { userId: actorId, action: 'grant.delete', target: id });
}

export function grantActions(subjectType: SubjectType) {
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
			await insertGrant(db, {
				subjectType,
				subjectId,
				pattern,
				actions,
				actorId: locals.user!.id
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
			await removeGrantRow(db, id, subjectType, subjectId, locals.user!.id);
			return { saved: true };
		}
	};
}
