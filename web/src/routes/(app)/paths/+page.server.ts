import { error } from '@sveltejs/kit';
import { canBrowseCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { readSession } from '$lib/server/cache/db';
import { likeTerm } from '$lib/server/store-paths';
import { parsePage } from '$lib/pagination';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

interface CacheRow {
	id: number;
	name: string;
	is_public: number;
}

interface PathRow {
	store_path: string;
	store_path_hash: string;
	created_at: string;
	nar_size: number;
	cache_name: string;
}

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	// Browse-only page: every query reads a replica session, keeping search
	// keystrokes (debounced client-side) off the write primary.
	const read = readSession(db);

	const [{ results: caches }, access] = await Promise.all([
		read
			.prepare('SELECT id, name, is_public FROM cache WHERE deleted_at IS NULL ORDER BY name')
			.all<CacheRow>(),
		effectiveAccessOf(locals, db)
	]);

	// Cross-cache browsing scope: public caches plus anything the user was
	// granted (canSeeCache). Every query below is bound to this id set, so a
	// private cache without a grant is both invisible and unqueryable.
	const inScope = caches.filter((c) =>
		canBrowseCache(access, { name: c.name, isPublic: c.is_public !== 0 })
	);

	// A cache filter naming anything outside the scope — private without
	// access or plain nonexistent — is indistinguishable from "no such cache".
	const cacheFilter = url.searchParams.get('cache');
	const selected = cacheFilter ? inScope.filter((c) => c.name === cacheFilter) : inScope;
	if (cacheFilter && selected.length === 0) {
		throw error(404, `Cache "${cacheFilter}" not found`);
	}

	const q = (url.searchParams.get('q') ?? '').trim();
	const page = parsePage(url.searchParams.get('page'));
	const cacheNames = inScope.map((c) => c.name);

	// The total rides on the rows as a window aggregate (computed before
	// LIMIT), so the footer costs no second scan. An empty IN () is invalid
	// SQL, so an empty scope skips the query outright.
	let results: (PathRow & { total: number })[] = [];
	if (selected.length > 0) {
		const ids = selected.map((c) => c.id);
		const inList = ids.map(() => '?').join(', ');
		const hasQ = q.length > 0;
		const where = `WHERE o.cache_id IN (${inList})${hasQ ? ` AND o.store_path LIKE ? ESCAPE '\\'` : ''}`;
		const filterBinds = hasQ ? [...ids, likeTerm(q)] : ids;
		({ results } = await read
			.prepare(
				`SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size,
				        c.name AS cache_name, COUNT(*) OVER () AS total
				 FROM object o
				 JOIN cache c ON c.id = o.cache_id
				 JOIN nar n ON n.id = o.nar_id
				 ${where}
				 ORDER BY o.created_at DESC, o.store_path ASC
				 LIMIT ? OFFSET ?`
			)
			.bind(...filterBinds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
			.all<PathRow & { total: number }>());
	}

	return {
		caches: cacheNames,
		cacheFilter: cacheFilter ?? null,
		q,
		page,
		pageSize: PAGE_SIZE,
		total: results[0]?.total ?? 0,
		hasMore: results.length > PAGE_SIZE,
		paths: results.slice(0, PAGE_SIZE).map((r) => ({
			storePath: r.store_path,
			hash: r.store_path_hash,
			createdAt: r.created_at,
			narSize: r.nar_size,
			cache: r.cache_name
		}))
	};
};
