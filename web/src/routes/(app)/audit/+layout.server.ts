import { error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { readSession } from '$lib/server/cache/db';
import { groupActions } from '$lib/audit-filters';
import type { LayoutServerLoad } from './$types';

/** Bounds on the filter option lists (distinct scans over audit_log). */
const MAX_ACTIONS = 100;
const MAX_ACTORS = 200;

// The filter option lists. A layout load that never reads `url`, so paging,
// filtering and search keystrokes re-run only the page's query — not these
// two full scans of audit_log.
export const load: LayoutServerLoad = async ({ platform, locals }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	const read = readSession(db);

	// Options come from what the log actually holds, so the list stays right
	// as new action names appear.
	const [actions, actors] = await Promise.all([
		read
			.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action LIMIT ${MAX_ACTIONS}`)
			.all<{ action: string }>(),
		read
			.prepare(
				`SELECT u.id, u.name, u.email
				 FROM (SELECT DISTINCT user_id FROM audit_log WHERE user_id IS NOT NULL) a
				 JOIN user u ON u.id = a.user_id
				 ORDER BY u.name LIMIT ${MAX_ACTORS}`
			)
			.all<{ id: string; name: string | null; email: string | null }>()
	]);
	return {
		actionGroups: groupActions(actions.results.map((a) => a.action)),
		actors: actors.results.map((u) => ({ id: u.id, label: u.name || u.email || u.id }))
	};
};
