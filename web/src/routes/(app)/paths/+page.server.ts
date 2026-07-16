import { error } from '@sveltejs/kit';
import { canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
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

/** Escape LIKE wildcards so a search term is matched literally. */
function likeTerm(q: string): string {
	return `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
}

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [{ results: caches }, access] = await Promise.all([
		db
			.prepare('SELECT id, name, is_public FROM cache WHERE deleted_at IS NULL ORDER BY name')
			.all<CacheRow>(),
		effectiveAccessOf(locals, db)
	]);

	// Cross-cache browsing scope: public caches plus anything the user was
	// granted (canSeeCache). Every query below is bound to this id set, so a
	// private cache without a grant is both invisible and unqueryable.
	const inScope = caches.filter((c) => c.is_public !== 0 || canSeeCache(access, c.name));

	// A cache filter naming anything outside the scope — private without
	// access or plain nonexistent — is indistinguishable from "no such cache".
	const cacheFilter = url.searchParams.get('cache');
	const selected = cacheFilter ? inScope.filter((c) => c.name === cacheFilter) : inScope;
	if (cacheFilter && selected.length === 0) {
		throw error(404, `Cache "${cacheFilter}" not found`);
	}

	const q = (url.searchParams.get('q') ?? '').trim();
	const page = Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1);
	const cacheNames = inScope.map((c) => c.name);

	if (selected.length === 0) {
		return {
			caches: cacheNames,
			cacheFilter: cacheFilter ?? null,
			q,
			page: 1,
			pageSize: PAGE_SIZE,
			total: 0,
			hasMore: false,
			paths: []
		};
	}

	const ids = selected.map((c) => c.id);
	const inList = ids.map(() => '?').join(', ');
	const hasQ = q.length > 0;
	const where = `WHERE o.cache_id IN (${inList})${hasQ ? ` AND o.store_path LIKE ? ESCAPE '\\'` : ''}`;
	const filterBinds = hasQ ? [...ids, likeTerm(q)] : ids;

	// Same shape as the audit page: one row past the page detects "next", the
	// COUNT drives the "X–Y of N" footer. Both share the bound id scoping.
	const [{ results }, total] = await Promise.all([
		db
			.prepare(
				`SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size,
				        c.name AS cache_name
				 FROM object o
				 JOIN cache c ON c.id = o.cache_id
				 JOIN nar n ON n.id = o.nar_id
				 ${where}
				 ORDER BY o.created_at DESC, o.store_path ASC
				 LIMIT ? OFFSET ?`
			)
			.bind(...filterBinds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
			.all<PathRow>(),
		db
			.prepare(`SELECT COUNT(*) AS n FROM object o ${where}`)
			.bind(...filterBinds)
			.first<{ n: number }>()
	]);

	return {
		caches: cacheNames,
		cacheFilter: cacheFilter ?? null,
		q,
		page,
		pageSize: PAGE_SIZE,
		total: total?.n ?? 0,
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
