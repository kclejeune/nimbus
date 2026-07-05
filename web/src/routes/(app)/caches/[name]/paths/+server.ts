import { json, error } from '@sveltejs/kit';
import { PATHS_PAGE_SIZE, parseSort, parseDir, queryStorePaths } from '$lib/server/store-paths';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const sort = parseSort(url.searchParams.get('sort'));
	const dir = parseDir(url.searchParams.get('dir'));
	const q = (url.searchParams.get('q') ?? '').trim();
	const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));

	const result = await queryStorePaths(db, params.name, {
		sort,
		dir,
		q,
		limit: PATHS_PAGE_SIZE,
		offset
	});
	return json(result);
};
