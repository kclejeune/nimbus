import type { D1Database } from '@cloudflare/workers-types';

/** Names of all live caches, alphabetical — for scope pickers and dropdowns. */
export async function listCacheNames(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT name FROM cache WHERE deleted_at IS NULL ORDER BY name')
		.all<{ name: string }>();
	return results.map((c) => c.name);
}
