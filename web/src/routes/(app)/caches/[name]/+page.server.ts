import { error, fail } from '@sveltejs/kit';
import {
	PATHS_PAGE_SIZE,
	parseSort,
	parseDir,
	queryStorePaths,
	countStorePaths
} from '$lib/server/store-paths';
import { detachClosure } from '$lib/server/cache/gc';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { canOnCache, canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf, requireCachePermission } from '$lib/server/auth/guard';
import type { PageServerLoad, Actions } from './$types';

interface CacheRow {
	id: number;
	name: string;
	is_public: number;
	priority: number;
	compression: string;
	retention_period: number | null;
	retention_max_bytes: number | null;
	store_dir: string;
	keypair: string;
}

/** The Nix trusted-key form of the cache keypair, or null when malformed. */
function derivePublicKey(keypair: string): string | null {
	try {
		return extractPublicKey(keypair);
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ platform, params, url, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const sort = parseSort(url.searchParams.get('sort'));
	const dir = parseDir(url.searchParams.get('dir'));
	const q = (url.searchParams.get('q') ?? '').trim();

	const [cache, access] = await Promise.all([
		db
			.prepare(
				`SELECT id, name, is_public, priority, compression, retention_period, retention_max_bytes,
				        store_dir, keypair
				 FROM cache WHERE name = ?1 AND deleted_at IS NULL`
			)
			.bind(params.name)
			.first<CacheRow>(),
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

	const cacheBase = (platform?.env.CACHE_BASE_URL ?? 'https://cache.kclj.io').replace(/\/$/, '');
	const publicKey = derivePublicKey(cache.keypair);

	const [{ paths, hasMore }, total, pinned, proxyPublicKey] = await Promise.all([
		queryStorePaths(db, params.name, { sort, dir, q, limit: PATHS_PAGE_SIZE, offset: 0 }),
		countStorePaths(db, params.name, q),
		db
			.prepare('SELECT store_path_hash FROM gc_root WHERE cache_id = ?1')
			.bind(cache.id)
			.all<{ store_path_hash: string }>(),
		getProxyKeypair(platform.env)
			.then(extractPublicKey)
			.catch(() => null)
	]);

	return {
		cache: {
			name: cache.name,
			isPublic: cache.is_public !== 0,
			priority: cache.priority,
			compression: cache.compression,
			retentionDays: cache.retention_period,
			retentionMaxBytes: cache.retention_max_bytes,
			storeDir: cache.store_dir,
			url: `${cacheBase}/${cache.name}`,
			publicKey
		},
		proxy: proxyPublicKey ? { url: cacheBase, publicKey: proxyPublicKey } : null,
		viewer,
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
	}
};
