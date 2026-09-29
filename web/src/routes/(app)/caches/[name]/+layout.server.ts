import { error } from '@sveltejs/kit';
import { cacheViewer, requireCacheBrowse } from '$lib/server/cache/cache-page';
import type { LayoutServerLoad } from './$types';

// The cache header and tab bar shared by every /caches/[name] tab. Each tab's
// own load still authorizes itself — layout and page loads run concurrently,
// so a layout check can't guard a page's queries — but both go through the
// per-request memo in requireCacheBrowse, so that costs one lookup, not two.
export const load: LayoutServerLoad = async ({ platform, params, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// The primary, not a replica: create and rename redirect straight here, and
	// a lagging replica would 404 the new name or show pre-save settings.
	const { cache, access } = await requireCacheBrowse(locals, db, params.name);
	return {
		cacheHeader: {
			name: cache.name,
			isPublic: cache.is_public !== 0,
			priority: cache.priority,
			compression: cache.compression,
			retentionDays: cache.retention_period,
			retentionMaxBytes: cache.retention_max_bytes
		},
		// Pins, Access and Settings are management surfaces, as before.
		cacheViewer: cacheViewer(access, params.name)
	};
};
