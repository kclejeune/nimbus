import { error } from '@sveltejs/kit';
import { canBrowseCache, canOnCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { readSession } from '$lib/server/cache/db';
import { getCache } from '$lib/server/cache/cache-page';
import type { LayoutServerLoad } from './$types';

// The cache header and tab bar shared by every /caches/[name] tab. Each tab's
// own load still authorizes itself — layout and page loads run concurrently,
// so a layout check can't guard a page's queries.
export const load: LayoutServerLoad = async ({ platform, params, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [cache, access] = await Promise.all([
		getCache(readSession(db), params.name),
		effectiveAccessOf(locals, db)
	]);
	if (!canBrowseCache(access, { name: cache.name, isPublic: cache.is_public !== 0 })) {
		throw error(403, 'Permission denied');
	}

	const canConfigure = canOnCache(access, 'cr', params.name);
	const canDestroy = canOnCache(access, 'cd', params.name);
	return {
		cacheHeader: {
			name: cache.name,
			isPublic: cache.is_public !== 0,
			priority: cache.priority,
			compression: cache.compression,
			retentionDays: cache.retention_period,
			retentionMaxBytes: cache.retention_max_bytes
		},
		cacheViewer: {
			// Pins, Access and Settings are management surfaces, as before.
			canManage: canConfigure || canDestroy,
			canConfigure,
			canDestroy
		}
	};
};
