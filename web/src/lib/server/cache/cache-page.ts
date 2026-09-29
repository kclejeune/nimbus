// Shared by the per-cache admin routes (/caches/[name]/…): the cache row
// lookup and form-field parsing their loads and actions have in common.
import { error } from '@sveltejs/kit';
import { STORE_PATH_HASH_RE } from '$lib/server/cache/db';

export interface CacheRow {
	id: number;
	name: string;
	is_public: number;
	priority: number;
	compression: string;
	retention_period: number | null;
	retention_max_bytes: number | null;
}

/** The live (not deleted) cache named `name`, or a 404. */
export async function getCache(
	db: App.Platform['env']['ATTIC_DB'],
	name: string
): Promise<CacheRow> {
	const cache = await db
		.prepare(
			`SELECT id, name, is_public, priority, compression, retention_period,
			        retention_max_bytes
			 FROM cache WHERE name = ?1 AND deleted_at IS NULL`
		)
		.bind(name)
		.first<CacheRow>();
	if (!cache) throw error(404, `Cache "${name}" not found`);
	return cache;
}

/** Accepts a full store path, `<hash>-name`, or a bare 32-char hash. */
export function parseStorePathHash(raw: string): string | null {
	const base = raw.trim().split('/').pop() ?? '';
	const hash = base.slice(0, 32).toLowerCase();
	return STORE_PATH_HASH_RE.test(hash) ? hash : null;
}

/** Fetch rows by id when the caller has a specific id list (non-admin label
 *  lookups); avoids shipping whole tables for a handful of labels. */
export async function rowsByIds<T>(
	db: App.Platform['env']['ATTIC_DB'],
	selectSql: string,
	ids: string[]
): Promise<T[]> {
	if (ids.length === 0) return [];
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(`${selectSql} WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<T>();
	return results;
}
