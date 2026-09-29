import { error, fail } from '@sveltejs/kit';
import {
	PATHS_PAGE_SIZE,
	parseSort,
	parseDir,
	queryStorePaths,
	countStorePaths
} from '$lib/server/store-paths';
import { detachClosure } from '$lib/server/cache/gc';
import { canOnCache, canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf, requireCachePermission } from '$lib/server/auth/guard';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, params, url, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const sort = parseSort(url.searchParams.get('sort'));
	const dir = parseDir(url.searchParams.get('dir'));
	const q = (url.searchParams.get('q') ?? '').trim();

	const [cache, access] = await Promise.all([
		db
			.prepare('SELECT id, name FROM cache WHERE name = ?1 AND deleted_at IS NULL')
			.bind(params.name)
			.first<{ id: number; name: string }>(),
		effectiveAccessOf(locals, db)
	]);

	if (!cache) throw error(404, `Cache "${params.name}" not found`);
	if (!canSeeCache(access, params.name)) {
		throw error(403, 'Permission denied');
	}
	const canRetention = canOnCache(access, 'cr', params.name);
	const viewer = {
		canRetention,
		canDelete: canOnCache(access, 'd', params.name),
		canManage: canRetention || canOnCache(access, 'cd', params.name)
	};

	const [{ paths, hasMore }, total, pinned] = await Promise.all([
		queryStorePaths(db, params.name, { sort, dir, q, limit: PATHS_PAGE_SIZE, offset: 0 }),
		countStorePaths(db, params.name, q),
		db
			.prepare('SELECT store_path_hash FROM gc_root WHERE cache_id = ?1')
			.bind(cache.id)
			.all<{ store_path_hash: string }>()
	]);

	return {
		cache: { name: cache.name },
		viewer,
		bulkMax: BULK_MAX,
		pinnedHashes: pinned.results.map((r) => r.store_path_hash),
		paths,
		hasMore,
		total,
		sort,
		dir,
		q
	};
};

async function cacheIdByName(db: App.Platform['env']['ATTIC_DB'], name: string): Promise<number> {
	const row = await db
		.prepare('SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NULL')
		.bind(name)
		.first<{ id: number }>();
	if (!row) throw error(404, `Cache "${name}" not found`);
	return row.id;
}

const HASH_RE = /^[0-9a-z]{32}$/;

/** Most paths one bulk action takes: removal runs a closure-safe detach and
 *  edge purges per path, so batches stay small enough to finish in a request. */
const BULK_MAX = 50;

/** The `hash` fields of a bulk form, deduplicated and validated. */
function parseHashes(form: FormData): { hashes: string[] } | { error: string } {
	const hashes = [...new Set(form.getAll('hash').map(String))];
	if (hashes.length === 0) return { error: 'Select at least one path.' };
	if (hashes.length > BULK_MAX) {
		return { error: `Select at most ${BULK_MAX} paths at a time.` };
	}
	if (!hashes.every((h) => HASH_RE.test(h))) return { error: 'Invalid path hash.' };
	return { hashes };
}

export const actions: Actions = {
	pin: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		// Pinning is a retention decision (same rule as the gc-root API route).
		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');

		const hash = String((await request.formData()).get('hash') ?? '');
		if (!HASH_RE.test(hash)) return fail(400, { actionError: 'Invalid path hash.' });

		const cacheId = await cacheIdByName(db, params.name);
		await db
			.prepare(
				'INSERT OR IGNORE INTO gc_root (cache_id, store_path_hash, created_at) VALUES (?1, ?2, ?3)'
			)
			.bind(cacheId, hash, new Date().toISOString())
			.run();
		return { pinned: hash };
	},

	unpin: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');

		const hash = String((await request.formData()).get('hash') ?? '');
		const cacheId = await cacheIdByName(db, params.name);
		await db
			.prepare('DELETE FROM gc_root WHERE cache_id = ?1 AND store_path_hash = ?2')
			.bind(cacheId, hash)
			.run();
		return { unpinned: hash };
	},

	prune: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		// Removing paths from the cache — the delete bit gates it.
		await requireCachePermission(locals, platform.env.ATTIC_DB, 'd', params.name, 'delete');

		const hash = String((await request.formData()).get('hash') ?? '');
		if (!HASH_RE.test(hash)) return fail(400, { actionError: 'Invalid path hash.' });

		// Detach, not delete: anything still referenced by another path keeps
		// serving (a removal must never break someone else's closure) and is
		// reaped by GC once its last referrer goes.
		const cacheId = await cacheIdByName(platform.env.ATTIC_DB, params.name);
		const { reaped } = await detachClosure(platform.env, platform.ctx, cacheId, params.name, hash);
		return { pruned: reaped };
	},

	pinMany: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');
		const parsed = parseHashes(await request.formData());
		if ('error' in parsed) return fail(400, { actionError: parsed.error });

		const cacheId = await cacheIdByName(db, params.name);
		const now = new Date().toISOString();
		await db.batch(
			parsed.hashes.map((hash) =>
				db
					.prepare(
						'INSERT OR IGNORE INTO gc_root (cache_id, store_path_hash, created_at) VALUES (?1, ?2, ?3)'
					)
					.bind(cacheId, hash, now)
			)
		);
		return { pinnedMany: parsed.hashes.length };
	},

	unpinMany: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');
		const parsed = parseHashes(await request.formData());
		if ('error' in parsed) return fail(400, { actionError: parsed.error });

		const cacheId = await cacheIdByName(db, params.name);
		await db.batch(
			parsed.hashes.map((hash) =>
				db
					.prepare('DELETE FROM gc_root WHERE cache_id = ?1 AND store_path_hash = ?2')
					.bind(cacheId, hash)
			)
		);
		return { unpinnedMany: parsed.hashes.length };
	},

	pruneMany: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		await requireCachePermission(locals, platform.env.ATTIC_DB, 'd', params.name, 'delete');
		const parsed = parseHashes(await request.formData());
		if ('error' in parsed) return fail(400, { actionError: parsed.error });

		// Same closure-safe detach as the single-row prune, run one path at a
		// time so each detach sees the effects of the ones before it.
		const cacheId = await cacheIdByName(platform.env.ATTIC_DB, params.name);
		let pruned = 0;
		for (const hash of parsed.hashes) {
			const { reaped } = await detachClosure(
				platform.env,
				platform.ctx,
				cacheId,
				params.name,
				hash
			);
			pruned += reaped;
		}
		return { pruned };
	}
};
