import { error, json } from '@sveltejs/kit';
import { browsableCaches } from '$lib/server/cache/cache-page';
import { readSession } from '$lib/server/cache/db';
import { likeTerm } from '$lib/server/store-paths';
import type { SearchResults } from '$lib/search';
import type { RequestHandler } from './$types';

const EMPTY: SearchResults = { caches: [], paths: [], users: [], groups: [] };

// The ⌘K palette's server half. Lives in the (app) group so the activation
// wall in hooks.server.ts covers it like any page. Scoped exactly like the
// pages it links to: browsable caches and their paths for everyone, people
// and groups for admins only.
export const GET: RequestHandler = async ({ url, platform, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	if (q.length < 2) return json(EMPTY);

	// Keystroke-driven (debounced client-side): keep it on a replica.
	const read = readSession(db);
	const like = likeTerm(q);
	// Never matches unless q could be the start of a nix-base32 hash.
	const hashPrefix = /^[0-9a-z]{4,32}$/.test(q) ? `${q}%` : '';
	const isAdmin = locals.user!.role === 'admin';

	const { caches: inScope } = await browsableCaches(locals, db, read);
	const needle = q.toLowerCase();

	const [paths, users, groups] = await Promise.all([
		inScope.length === 0
			? []
			: read
					.prepare(
						`SELECT o.store_path, o.store_path_hash, c.name AS cache_name
						 FROM object o JOIN cache c ON c.id = o.cache_id
						 WHERE o.cache_id IN (SELECT value FROM json_each(?))
						   AND (substr(o.store_path, instr(o.store_path, o.store_path_hash) + 33)
						          LIKE ? ESCAPE '\\'
						        OR o.store_path_hash LIKE ? ESCAPE '\\')
						 ORDER BY o.created_at DESC LIMIT 8`
					)
					// Match the name after `<hash>-`, not inside the random hash —
					// except as a prefix, for someone pasting a hash.
					.bind(JSON.stringify(inScope.map((c) => c.id)), like, hashPrefix)
					.all<{ store_path: string; store_path_hash: string; cache_name: string }>()
					.then((r) => r.results),
		isAdmin
			? read
					.prepare(
						`SELECT id, name, email FROM user
						 WHERE name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\'
						 ORDER BY name LIMIT 5`
					)
					.bind(like)
					.all<{ id: string; name: string; email: string }>()
					.then((r) => r.results)
			: [],
		isAdmin
			? read
					.prepare(
						`SELECT id, name FROM groups WHERE name LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT 5`
					)
					.bind(like)
					.all<{ id: string; name: string }>()
					.then((r) => r.results)
			: []
	]);

	return json({
		caches: inScope
			.filter((c) => c.name.toLowerCase().includes(needle))
			.slice(0, 5)
			.map((c) => ({ name: c.name, isPublic: c.is_public !== 0 })),
		paths: paths.map((p) => ({
			storePath: p.store_path,
			hash: p.store_path_hash,
			cache: p.cache_name
		})),
		users,
		groups
	} satisfies SearchResults);
};
