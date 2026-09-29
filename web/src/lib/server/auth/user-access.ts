import type { D1Database } from '@cloudflare/workers-types';

export interface UserAccess {
	memberships: { id: string; name: string; source: string }[];
	/** Direct grants on the user. */
	grants: { id: string; pattern: string; actions: string }[];
	/** Grants inherited through group membership. */
	viaGroups: {
		id: string;
		pattern: string;
		actions: string;
		group_id: string;
		group_name: string;
	}[];
}

/**
 * A user's groups and cache grants, direct and inherited: "what can this
 * user touch?" in one place. Shared by the admin user page and the viewer's
 * own profile; callers enforce who may ask about whom.
 */
export async function loadUserAccess(db: D1Database, userId: string): Promise<UserAccess> {
	const [memberships, grants, viaGroups] = await Promise.all([
		db
			.prepare(
				`SELECT g.id, g.name, m.source FROM group_member m
				 JOIN groups g ON g.id = m.group_id WHERE m.user_id = ?1 ORDER BY g.name`
			)
			.bind(userId)
			.all<UserAccess['memberships'][number]>(),
		db
			.prepare(
				`SELECT id, pattern, actions FROM permission_grant
				 WHERE subject_type = 'user' AND subject_id = ?1 ORDER BY pattern`
			)
			.bind(userId)
			.all<UserAccess['grants'][number]>(),
		db
			.prepare(
				`SELECT pg.id, pg.pattern, pg.actions, gr.id AS group_id, gr.name AS group_name
				 FROM permission_grant pg
				 JOIN group_member m ON m.group_id = pg.subject_id AND m.user_id = ?1
				 JOIN groups gr ON gr.id = pg.subject_id
				 WHERE pg.subject_type = 'group'
				 ORDER BY pg.pattern, gr.name`
			)
			.bind(userId)
			.all<UserAccess['viaGroups'][number]>()
	]);
	return {
		memberships: memberships.results,
		grants: grants.results,
		viaGroups: viaGroups.results
	};
}
