import { error, fail, redirect } from '@sveltejs/kit';
import { atticFetch, adminAccess } from '$lib/server/attic-api';
import { listGcRoots } from '$lib/server/attic/gc';
import { CACHE_NAME_RE } from '$lib/utils';
import type { PageServerLoad, Actions } from './$types';

interface CacheRow {
	id: number;
	name: string;
	is_public: number;
	priority: number;
	compression: string;
	retention_period: number | null;
	retention_max_bytes: number | null;
	upstream_caches: string;
}

const STORE_PATH_HASH_RE = /^[0-9a-df-np-sv-z]{32}$/;

/** Accepts a full store path, `<hash>-name`, or a bare 32-char hash. */
function parseStorePathHash(raw: string): string | null {
	const base = raw.trim().split('/').pop() ?? '';
	const hash = base.slice(0, 32).toLowerCase();
	return STORE_PATH_HASH_RE.test(hash) ? hash : null;
}

function parseUpstreamList(raw: string): string[] | null {
	const urls = raw
		.split('\n')
		.map((u) => u.trim().replace(/\/+$/, ''))
		.filter(Boolean);
	for (const u of urls) {
		try {
			const parsed = new URL(u);
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
		} catch {
			return null;
		}
	}
	return urls;
}

async function getCache(db: App.Platform['env']['ATTIC_DB'], name: string): Promise<CacheRow> {
	const cache = await db
		.prepare(
			`SELECT id, name, is_public, priority, compression, retention_period,
			        retention_max_bytes, upstream_caches
			 FROM cache WHERE name = ?1 AND deleted_at IS NULL`
		)
		.bind(name)
		.first<CacheRow>();
	if (!cache) throw error(404, `Cache "${name}" not found`);
	return cache;
}

export const load: PageServerLoad = async ({ platform, params }) => {
	const env = platform?.env;
	if (!env) throw error(500, 'Platform bindings unavailable');

	const cache = await getCache(env.ATTIC_DB, params.name);
	const roots = await listGcRoots(env, cache.id);

	let upstreams: string[] = [];
	try {
		const parsed = JSON.parse(cache.upstream_caches);
		if (Array.isArray(parsed)) upstreams = parsed;
	} catch {
		// treat unparseable config as empty
	}

	return {
		cache: {
			name: cache.name,
			isPublic: cache.is_public !== 0,
			priority: cache.priority,
			compression: cache.compression,
			retentionDays: cache.retention_period,
			retentionMaxBytes: cache.retention_max_bytes,
			upstreams
		},
		roots
	};
};

export const actions: Actions = {
	save: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const form = await request.formData();
		const isPublic = form.get('is_public') === 'on';
		const priority = Number(form.get('priority') ?? 40);
		const compression = String(form.get('compression') ?? 'zstd');
		const retentionRaw = String(form.get('retention_period') ?? '').trim();
		const retention = retentionRaw === '' ? null : Number(retentionRaw);

		const maxGibRaw = String(form.get('retention_max_gib') ?? '').trim();
		const maxGib = maxGibRaw === '' ? null : Number(maxGibRaw);
		if (maxGib !== null && (!Number.isFinite(maxGib) || maxGib <= 0)) {
			return fail(400, { error: 'Size limit must be a positive number of GiB.' });
		}

		const upstreams = parseUpstreamList(String(form.get('upstream_caches') ?? ''));
		if (upstreams === null) {
			return fail(400, { error: 'Upstream caches must be http(s) URLs, one per line.' });
		}

		// Fields the attic API knows about go through it (validation, audit);
		// the retention/upstream extensions are admin-owned columns.
		const res = await atticFetch(
			platform.env,
			{ userId: locals.user.id, caches: adminAccess() },
			`/_api/v1/cache-config/${encodeURIComponent(params.name)}`,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					is_public: isPublic,
					priority,
					compression,
					retention_period: retention
				})
			}
		);
		if (!res.ok) {
			return fail(502, { error: `Failed to save: ${await res.text()}` });
		}

		await platform.env.ATTIC_DB.prepare(
			'UPDATE cache SET retention_max_bytes = ?1, upstream_caches = ?2 WHERE name = ?3'
		)
			.bind(
				maxGib === null ? null : Math.round(maxGib * 2 ** 30),
				JSON.stringify(upstreams),
				params.name
			)
			.run();

		return { saved: true };
	},

	addRoot: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const form = await request.formData();
		const hash = parseStorePathHash(String(form.get('path') ?? ''));
		if (!hash) {
			return fail(400, { rootError: 'Enter a store path or its 32-character hash.' });
		}

		const cache = await getCache(db, params.name);
		const exists = await db
			.prepare('SELECT 1 AS x FROM object WHERE cache_id = ?1 AND store_path_hash = ?2')
			.bind(cache.id, hash)
			.first();
		if (!exists) {
			return fail(400, { rootError: `No path with hash ${hash} in this cache.` });
		}

		const note = String(form.get('note') ?? '').trim() || null;
		await db
			.prepare(
				'INSERT OR IGNORE INTO gc_root (cache_id, store_path_hash, note, created_at) VALUES (?1, ?2, ?3, ?4)'
			)
			.bind(cache.id, hash, note, new Date().toISOString())
			.run();
		return { rootAdded: true };
	},

	removeRoot: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const hash = String((await request.formData()).get('hash') ?? '');
		const cache = await getCache(db, params.name);
		await db
			.prepare('DELETE FROM gc_root WHERE cache_id = ?1 AND store_path_hash = ?2')
			.bind(cache.id, hash)
			.run();
		return { rootRemoved: true };
	},

	rename: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const newName = String((await request.formData()).get('new_name') ?? '').trim();

		if (!CACHE_NAME_RE.test(newName)) {
			return fail(400, {
				renameError: 'Name must be lowercase alphanumeric with dashes (max 50 chars).'
			});
		}
		if (newName === params.name) {
			return fail(400, { renameError: 'That is already the cache name.' });
		}

		const res = await atticFetch(
			platform.env,
			{ userId: locals.user.id, caches: adminAccess() },
			`/_api/v1/cache-config/${encodeURIComponent(params.name)}/rename`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ new_name: newName })
			}
		);

		if (!res.ok) {
			const detail = await res.text();
			return fail(res.status === 409 ? 409 : 502, {
				renameError:
					res.status === 409
						? `A cache named "${newName}" already exists.`
						: `Failed to rename: ${detail}`
			});
		}

		redirect(303, `/caches/${newName}/settings`);
	},

	delete: async ({ locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const res = await atticFetch(
			platform.env,
			{ userId: locals.user.id, caches: adminAccess() },
			`/_api/v1/cache-config/${encodeURIComponent(params.name)}`,
			{ method: 'DELETE' }
		);

		if (!res.ok) {
			return fail(502, { deleteError: `Failed to delete: ${await res.text()}` });
		}

		redirect(303, '/caches');
	}
};
