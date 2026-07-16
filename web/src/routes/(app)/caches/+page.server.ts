import { error } from '@sveltejs/kit';
import { canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import type { PageServerLoad } from './$types';

interface CacheRow {
	id: number;
	name: string;
	is_public: number;
	priority: number;
	compression: string;
	retention_period: number | null;
	retention_max_bytes: number | null;
	objects: number;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [{ results }, sizes, access] = await Promise.all([
		db
			.prepare(
				`SELECT c.id, c.name, c.is_public, c.priority, c.compression,
				        c.retention_period, c.retention_max_bytes,
				        (SELECT COUNT(*) FROM object o WHERE o.cache_id = c.id) AS objects
				 FROM cache c
				 WHERE c.deleted_at IS NULL
				 ORDER BY c.name`
			)
			.all<CacheRow>(),
		// Physical compressed bytes per cache, deduplicated within the cache
		// (a NAR shared by several store paths counts once). Caches sharing
		// content each count it, so these sums can overlap across caches.
		db
			.prepare(
				`SELECT o.cache_id, COALESCE(SUM(sz.bytes), 0) AS bytes
				 FROM (SELECT DISTINCT cache_id, nar_id FROM object) o
				 JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr
				       JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz
				   ON sz.nar_id = o.nar_id
				 GROUP BY o.cache_id`
			)
			.all<{ cache_id: number; bytes: number }>(),
		effectiveAccessOf(locals, db)
	]);

	const sizeByCache = new Map(sizes.results.map((r) => [r.cache_id, r.bytes]));
	const visible = results.filter((c) => canSeeCache(access, c.name));

	return {
		caches: visible.map((c) => ({
			name: c.name,
			isPublic: c.is_public !== 0,
			priority: c.priority,
			compression: c.compression,
			retentionDays: c.retention_period,
			retentionMaxBytes: c.retention_max_bytes,
			objects: c.objects,
			storageBytes: sizeByCache.get(c.id) ?? 0
		}))
	};
};
