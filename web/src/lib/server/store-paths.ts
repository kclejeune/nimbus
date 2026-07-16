import type { D1Database } from '@cloudflare/workers-types';

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
	return `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
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
