import { json, error } from '@sveltejs/kit';
import { PATHS_PAGE_SIZE, parseSort, parseDir, queryStorePaths } from '$lib/server/store-paths';
import { canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { readSession } from '$lib/server/cache/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, params, url, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	// Scroll/filter fetches for the store-path browser: read-heavy and
	// lag-tolerant, so they stay off the primary.
	const read = readSession(db);

	const cache = await read
		.prepare('SELECT 1 AS x FROM cache WHERE name = ?1 AND deleted_at IS NULL')
		.bind(params.name)
		.first();
	if (!cache) throw error(404, `Cache "${params.name}" not found`);
	const access = await effectiveAccessOf(locals, db);
	if (!canSeeCache(access, params.name)) {
		throw error(403, 'Permission denied');
	}

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
