import { error, fail } from '@sveltejs/kit';
import {
	PATHS_PAGE_SIZE,
	parseSort,
	parseDir,
	queryStorePaths,
	countStorePaths
} from '$lib/server/store-paths';
import { pruneClosure } from '$lib/server/cache/gc';
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

/** Keypair is stored as `{name}:{base64(secret32 || public32)}`; return the Nix trusted-key form. */
function derivePublicKey(keypair: string): string | null {
	const idx = keypair.indexOf(':');
	if (idx < 0) return null;
	const name = keypair.slice(0, idx);
	try {
		const raw = Uint8Array.from(atob(keypair.slice(idx + 1)), (c) => c.charCodeAt(0));
		if (raw.length < 64) return null;
		let bin = '';
		for (const b of raw.slice(32, 64)) bin += String.fromCharCode(b);
		return `${name}:${btoa(bin)}`;
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

	const cache = await db
		.prepare(
			`SELECT id, name, is_public, priority, compression, retention_period, retention_max_bytes,
			        store_dir, keypair
			 FROM cache WHERE name = ?1 AND deleted_at IS NULL`
		)
		.bind(params.name)
		.first<CacheRow>();

	if (!cache) throw error(404, `Cache "${params.name}" not found`);

	const access = await effectiveAccessOf(locals, db);
	if (!canSeeCache(access, params.name, cache.is_public !== 0)) {
		throw error(403, 'Permission denied');
	}

	const cacheBase = (platform?.env.CACHE_BASE_URL ?? 'https://cache.kclj.io').replace(/\/$/, '');
	const publicKey = derivePublicKey(cache.keypair);

	const [{ paths, hasMore }, total, pinned] = await Promise.all([
		queryStorePaths(db, params.name, { sort, dir, q, limit: PATHS_PAGE_SIZE, offset: 0 }),
		countStorePaths(db, params.name, q),
		db
			.prepare('SELECT store_path_hash FROM gc_root WHERE cache_id = ?1')
			.bind(cache.id)
			.all<{ store_path_hash: string }>()
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
		const access = await effectiveAccessOf(locals, db);
		if (!canOnCache(access, 'cq', params.name) && !canOnCache(access, 'cr', params.name)) {
			throw error(403, 'Permission denied: configure cache retention');
		}

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

		const access = await effectiveAccessOf(locals, db);
		if (!canOnCache(access, 'cq', params.name) && !canOnCache(access, 'cr', params.name)) {
			throw error(403, 'Permission denied: configure cache retention');
		}

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

		// Pruning deletes paths from the cache — the delete bit gates it.
		await requireCachePermission(locals, platform.env.ATTIC_DB, 'd', params.name, 'delete');

		const hash = String((await request.formData()).get('hash') ?? '');
		if (!HASH_RE.test(hash)) return fail(400, { actionError: 'Invalid path hash.' });

		const cacheId = await cacheIdByName(platform.env.ATTIC_DB, params.name);
		const pruned = await pruneClosure(platform.env, cacheId, hash);
		return { pruned };
	}
};
