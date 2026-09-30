import { error } from '@sveltejs/kit';
import { canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { cacheSizes } from '$lib/server/cache/gc';
import { readSession } from '$lib/server/cache/db';
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

	const [{ results }, access] = await Promise.all([
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
		effectiveAccessOf(locals, db)
	]);

	const visible = results.filter((c) => canSeeCache(access, c.name));
	// Physical compressed bytes per cache; sums can overlap across caches
	// that share content. Keyed by name, for the visible caches only. Streamed:
	// the table renders at once and the Size column fills in (the walk is
	// memoized in cacheSizes, but a cold one is slow).
	const storageBytes = cacheSizes(readSession(db)).then((m) =>
		Object.fromEntries(visible.map((c) => [c.name, m.get(c.id) ?? 0]))
	);

	return {
		caches: visible.map((c) => ({
			name: c.name,
			isPublic: c.is_public !== 0,
			priority: c.priority,
			compression: c.compression,
			retentionDays: c.retention_period,
			retentionMaxBytes: c.retention_max_bytes,
			objects: c.objects
		})),
		storageBytes
	};
};
