import type { D1Database } from '@cloudflare/workers-types';
import { escapeLike } from '$lib/utils';
import { IN_IDS } from '$lib/server/cache/cache-page';

/** Rows fetched per page for the store-paths list (initial load + each scroll). */
export const PATHS_PAGE_SIZE = 25;

const SORT_COLUMNS = {
	date: 'o.created_at',
	size: 'n.nar_size',
	name: 'o.store_path'
} as const;

export type SortKey = keyof typeof SORT_COLUMNS;
export type SortDir = 'asc' | 'desc';

export function parseSort(v: string | null): SortKey {
	return v === 'size' || v === 'name' ? v : 'date';
}

export function parseDir(v: string | null): SortDir {
	return v === 'asc' ? 'asc' : 'desc';
}

export interface PathRow {
	store_path: string;
	store_path_hash: string;
	nar_size: number;
	created_at: string;
}

export interface StorePath {
	storePath: string;
	hash: string;
	narSize: number;
	createdAt: string;
}

const toStorePath = (p: PathRow): StorePath => ({
	storePath: p.store_path,
	hash: p.store_path_hash,
	narSize: p.nar_size,
	createdAt: p.created_at
});

/** Escape LIKE wildcards so a search term is matched literally. */
export function likeTerm(q: string): string {
	return `%${escapeLike(q)}%`;
}

/**
 * Fetch one page of store paths, sorted and optionally filtered by name.
 * Fetches one extra row to report `hasMore` without a second COUNT query.
 * A store_path tiebreak keeps offset paging stable across scroll fetches.
 */
export async function queryStorePaths(
	db: D1Database,
	cacheName: string,
	opts: { sort: SortKey; dir: SortDir; q: string; limit: number; offset: number }
): Promise<{ paths: StorePath[]; hasMore: boolean }> {
	const col = SORT_COLUMNS[opts.sort];
	const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
	const hasQ = opts.q.length > 0;

	const where = hasQ
		? `WHERE c.name = ?1 AND o.store_path LIKE ?4 ESCAPE '\\'`
		: `WHERE c.name = ?1`;

	const stmt = db.prepare(
		`SELECT o.store_path, o.store_path_hash, n.nar_size, o.created_at
		 FROM object o
		 JOIN cache c ON c.id = o.cache_id
		 JOIN nar n ON n.id = o.nar_id
		 ${where}
		 ORDER BY ${col} ${dir}, o.store_path ASC
		 LIMIT ?2 OFFSET ?3`
	);

	const binds = hasQ
		? [cacheName, opts.limit + 1, opts.offset, likeTerm(opts.q)]
		: [cacheName, opts.limit + 1, opts.offset];

	const { results } = await stmt.bind(...binds).all<PathRow>();
	const hasMore = results.length > opts.limit;
	const page = hasMore ? results.slice(0, opts.limit) : results;
	return { paths: page.map(toStorePath), hasMore };
}

/** Count store paths in a cache, honoring the same name filter. */
export async function countStorePaths(
	db: D1Database,
	cacheName: string,
	q: string
): Promise<number> {
	const hasQ = q.length > 0;
	const stmt = db.prepare(
		`SELECT COUNT(*) AS n
		 FROM object o
		 JOIN cache c ON c.id = o.cache_id
		 ${hasQ ? `WHERE c.name = ?1 AND o.store_path LIKE ?2 ESCAPE '\\'` : `WHERE c.name = ?1`}`
	);
	const row = await (hasQ ? stmt.bind(cacheName, likeTerm(q)) : stmt.bind(cacheName)).first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

export interface CrossCachePath extends PathRow {
	cache_name: string;
}

/** A cross-cache row as the pages render it. */
export const toCrossCachePath = (p: CrossCachePath) => ({ ...toStorePath(p), cache: p.cache_name });

/**
 * Newest store paths across several caches, one page at a time (the /paths
 * explorer and the overview's recent pushes). Sorting the union directly
 * reads and joins every object in scope before LIMIT applies — 171k rows
 * for six rows on prod. Instead each cache yields its own newest
 * `offset + limit` from idx_object_cache_created, so the merge only ever
 * sees `caches × (offset + limit)` candidates. Ties break on store_path, so
 * pages stay stable.
 */
export async function newestAcrossCaches(
	db: D1Database,
	cacheIds: number[],
	limit: number,
	offset = 0
): Promise<CrossCachePath[]> {
	if (cacheIds.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size, c.name AS cache_name
			 FROM json_each(?1) j
			 JOIN object o ON o.id IN (
			   SELECT id FROM object WHERE cache_id = j.value
			   ORDER BY created_at DESC, store_path ASC LIMIT ?2)
			 JOIN cache c ON c.id = o.cache_id
			 JOIN nar n ON n.id = o.nar_id
			 ORDER BY o.created_at DESC, o.store_path ASC
			 LIMIT ?3 OFFSET ?4`
		)
		.bind(JSON.stringify(cacheIds), offset + limit, limit, offset)
		.all<CrossCachePath>();
	return results;
}

/** Store paths in the given caches, for a pager's "of N". Index-only. */
export async function countAcrossCaches(db: D1Database, cacheIds: number[]): Promise<number> {
	if (cacheIds.length === 0) return 0;
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM object WHERE cache_id ${IN_IDS}`)
		.bind(JSON.stringify(cacheIds))
		.first<{ n: number }>();
	return row?.n ?? 0;
}
