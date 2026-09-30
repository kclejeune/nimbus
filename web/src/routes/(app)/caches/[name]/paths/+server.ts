import { json, error } from '@sveltejs/kit';
import { PATHS_PAGE_SIZE, parseSort, parseDir, queryStorePaths } from '$lib/server/store-paths';
import { requireCacheBrowse } from '$lib/server/cache/cache-page';
import { readSession } from '$lib/server/cache/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	// Scroll/filter fetches for the store-path browser: read-heavy and
	// lag-tolerant, so they stay off the primary — the access check included.
	// A just-revoked grant can pass here until the replica catches up; that
	// brief window is accepted to keep per-scroll load off the primary (the
	// page load and every write still authorize against it).
	const read = readSession(db);

	await requireCacheBrowse(locals, read, params.name);

	const sort = parseSort(url.searchParams.get('sort'));
	const dir = parseDir(url.searchParams.get('dir'));
	const q = (url.searchParams.get('q') ?? '').trim();
	const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));

	const result = await queryStorePaths(read, params.name, {
		sort,
		dir,
		q,
		limit: PATHS_PAGE_SIZE,
		offset
	});
	return json(result);
};
