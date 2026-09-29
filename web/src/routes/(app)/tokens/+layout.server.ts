import { error } from '@sveltejs/kit';
import { listTokenOwners } from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { readSession } from '$lib/server/cache/db';
import { tokenScopeOptions } from '$lib/server/auth/permissions';
import type { LayoutServerLoad } from './$types';

// What doesn't depend on the filters: the new-token form's scope options and
// the owner filter's list. A layout load that never reads `url`, so filter
// changes and paging re-run only the page's token query.
export const load: LayoutServerLoad = async ({ platform, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	const isAdmin = locals.user.role === 'admin';

	const [cacheNames, access, owners] = await Promise.all([
		listCacheNames(db),
		effectiveAccessOf(locals, db),
		// A stale option list is harmless, so it reads a replica.
		isAdmin ? listTokenOwners(readSession(db)) : []
	]);
	return { scopeOptions: tokenScopeOptions(access, cacheNames), isAdmin, owners };
};
