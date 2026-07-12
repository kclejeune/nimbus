import { error } from '@sveltejs/kit';
import { canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import type { PageServerLoad } from './$types';

interface CacheRow {
	name: string;
	is_public: number;
	priority: number;
	compression: string;
	retention_period: number | null;
	objects: number;
	storage_bytes: number;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const { results } = await db
		.prepare(
			`SELECT c.name, c.is_public, c.priority, c.compression, c.retention_period,
			        COUNT(DISTINCT o.id) AS objects,
			        COALESCE(SUM(ch.file_size), 0) AS storage_bytes
			 FROM cache c
			 LEFT JOIN object o ON o.cache_id = c.id
			 LEFT JOIN nar n ON n.id = o.nar_id
			 LEFT JOIN chunkref cr ON cr.nar_id = n.id
			 LEFT JOIN chunk ch ON ch.id = cr.chunk_id
			 WHERE c.deleted_at IS NULL
			 GROUP BY c.id
			 ORDER BY c.name`
		)
		.all<CacheRow>();

	const access = await effectiveAccessOf(locals, db);
	const visible = results.filter((c) => canSeeCache(access, c.name));

	return {
		caches: visible.map((c) => ({
			name: c.name,
			isPublic: c.is_public !== 0,
			priority: c.priority,
			compression: c.compression,
			retentionDays: c.retention_period,
			objects: c.objects,
			storageBytes: c.storage_bytes
		}))
	};
};
