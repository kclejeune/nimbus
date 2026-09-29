import { error } from '@sveltejs/kit';
import { readSession } from '$lib/server/cache/db';
import { AsyncMemo } from '$lib/server/cache/async-memo';
import {
	countAcrossCaches,
	likeTerm,
	newestAcrossCaches,
	toCrossCachePath,
	type CrossCachePath
} from '$lib/server/store-paths';
import { browsableCaches, IN_IDS } from '$lib/server/cache/cache-page';
import { parsePage } from '$lib/pagination';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

/** The unfiltered pager's "of N": an index scan of every object in scope, so
 *  paging and revisits reuse it for a minute rather than recounting. */
const totals = new AsyncMemo<number>(60_000, 64);

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	// Browse-only page: every query reads a replica session, keeping search
	// keystrokes (debounced client-side) off the write primary.
	const read = readSession(db);

	const { caches: inScope } = await browsableCaches(locals, db, read);

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

	// One row past the page detects "next".
	const ids = selected.map((c) => c.id);
	const offset = (page - 1) * PAGE_SIZE;
	let results: (CrossCachePath & { total?: number })[];
	let total: number;
	if (q) {
		// A name search scans the scope anyway, so the total rides on the rows
		// as a window aggregate (computed before LIMIT) at no extra cost.
		({ results } = await read
			.prepare(
				`SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size,
				        c.name AS cache_name, COUNT(*) OVER () AS total
				 FROM object o
				 JOIN cache c ON c.id = o.cache_id
				 JOIN nar n ON n.id = o.nar_id
				 WHERE o.cache_id ${IN_IDS} AND o.store_path LIKE ?2 ESCAPE '\\'
				 ORDER BY o.created_at DESC, o.store_path ASC
				 LIMIT ?3 OFFSET ?4`
			)
			.bind(JSON.stringify(ids), likeTerm(q), PAGE_SIZE + 1, offset)
			.all<CrossCachePath & { total: number }>());
		total = results[0]?.total ?? 0;
	} else {
		// Unfiltered: per-cache index walks, not a sort of the whole scope.
		[results, total] = await Promise.all([
			newestAcrossCaches(read, ids, PAGE_SIZE + 1, offset),
			totals.get(JSON.stringify(ids), () => countAcrossCaches(read, ids))
		]);
	}

	return {
		caches: cacheNames,
		cacheFilter: cacheFilter ?? null,
		q,
		page,
		pageSize: PAGE_SIZE,
		total,
		hasMore: results.length > PAGE_SIZE,
		paths: results.slice(0, PAGE_SIZE).map(toCrossCachePath)
	};
};
