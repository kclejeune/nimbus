import { error, fail, redirect } from '@sveltejs/kit';
import {
	CacheConfigError,
	configureCache,
	destroyCache,
	renameCache
} from '$lib/server/cache/cache-config';
import { listGcRoots } from '$lib/server/cache/gc';
import {
	canOnCache,
	parseGrantActions,
	partitionCacheGrants,
	type CacheGrantRow
} from '$lib/server/auth/permissions';
import { insertGrant, removeGrantRow } from '$lib/server/auth/grants';
import {
	effectiveAccessOf,
	requireAdmin,
	requireAnyCachePermission,
	requireCachePermission
} from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
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

export const load: PageServerLoad = async ({ platform, params, locals }) => {
	const env = platform?.env;
	if (!env) throw error(500, 'Platform bindings unavailable');

	const cache = await getCache(env.ATTIC_DB, params.name);

	const access = await effectiveAccessOf(locals, env.ATTIC_DB);
	const canConfigure = canOnCache(access, 'cr', params.name);
	const canRetention = canConfigure || canOnCache(access, 'cq', params.name);
	const canDestroy = canOnCache(access, 'cd', params.name);
	if (
		!canRetention &&
		!canDestroy &&
		cache.is_public === 0 &&
		!canOnCache(access, 'r', params.name)
	) {
		throw error(403, 'Permission denied');
	}

	const isAdmin = locals.user!.role === 'admin';
	const [roots, grantRows, userRows, groupRows] = await Promise.all([
		listGcRoots(env, cache.id),
		env.ATTIC_DB.prepare(
			'SELECT id, subject_type, subject_id, pattern, actions FROM permission_grant'
		).all<CacheGrantRow>(),
		env.ATTIC_DB.prepare('SELECT id, name, email FROM user ORDER BY name').all<{
			id: string;
			name: string;
			email: string;
		}>(),
		env.ATTIC_DB.prepare('SELECT id, name FROM groups ORDER BY name').all<{
			id: string;
			name: string;
		}>()
	]);

	const userLabel = new Map(userRows.results.map((u) => [u.id, `${u.name} (${u.email})`]));
	const groupLabel = new Map(groupRows.results.map((g) => [g.id, g.name]));
	const subjectLabel = (g: CacheGrantRow) =>
		(g.subject_type === 'user' ? userLabel.get(g.subject_id) : groupLabel.get(g.subject_id)) ??
		g.subject_id;
	const { direct, viaPatterns } = partitionCacheGrants(grantRows.results, params.name);
	const describe = (g: CacheGrantRow) => ({
		id: g.id,
		subjectType: g.subject_type,
		subjectId: g.subject_id,
		subjectLabel: subjectLabel(g),
		pattern: g.pattern,
		actions: g.actions
	});

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
		roots,
		permissions: { canConfigure, canRetention, canDestroy },
		isAdmin,
		access: { direct: direct.map(describe), viaPatterns: viaPatterns.map(describe) },
		subjects: isAdmin
			? [
					...userRows.results.map((u) => ({
						value: `user:${u.id}`,
						label: `${u.name} (${u.email})`
					})),
					...groupRows.results.map((g) => ({ value: `group:${g.id}`, label: `${g.name} (group)` }))
				]
			: []
	};
};

export const actions: Actions = {
	save: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const access = await requireAnyCachePermission(
			locals,
			platform.env.ATTIC_DB,
			['cq', 'cr'],
			params.name,
			'configure cache'
		);
		const canConfigure = canOnCache(access, 'cr', params.name);

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
		const maxBytes = maxGib === null ? null : Math.round(maxGib * 2 ** 30);

		const upstreams = parseUpstreamList(String(form.get('upstream_caches') ?? ''));
		if (upstreams === null) {
			return fail(400, { error: 'Upstream caches must be http(s) URLs, one per line.' });
		}

		try {
			// Retention-only permission (cq without cr) applies only the retention
			// fields; the visibility/priority/compression/upstream inputs are ignored.
			await configureCache(
				platform.env,
				params.name,
				canConfigure
					? {
							is_public: isPublic,
							priority,
							compression,
							retention_period: retention,
							retention_max_bytes: maxBytes
						}
					: { retention_period: retention, retention_max_bytes: maxBytes }
			);
		} catch (e) {
			const status = e instanceof CacheConfigError ? e.status : 502;
			return fail(status, { error: `Failed to save: ${e instanceof Error ? e.message : e}` });
		}

		// The one column configureCache doesn't cover.
		if (canConfigure) {
			await platform.env.ATTIC_DB.prepare('UPDATE cache SET upstream_caches = ?1 WHERE name = ?2')
				.bind(JSON.stringify(upstreams), params.name)
				.run();
		}

		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user.id,
			action: 'cache.configure',
			target: params.name
		});

		return { saved: true };
	},

	addRoot: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		await requireAnyCachePermission(
			locals,
			db,
			['cq', 'cr'],
			params.name,
			'configure cache retention'
		);

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

		await requireAnyCachePermission(
			locals,
			db,
			['cq', 'cr'],
			params.name,
			'configure cache retention'
		);

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

		// Renaming is a configure on the source and a create on the target.
		await requireCachePermission(
			locals,
			platform.env.ATTIC_DB,
			'cr',
			params.name,
			'configure cache'
		);
		await requireCachePermission(
			locals,
			platform.env.ATTIC_DB,
			'cc',
			newName,
			'create cache (target name)'
		);

		try {
			await renameCache(platform.env, params.name, newName);
		} catch (e) {
			const status = e instanceof CacheConfigError ? e.status : 502;
			return fail(status, {
				renameError:
					status === 409
						? `A cache named "${newName}" already exists.`
						: `Failed to rename: ${e instanceof Error ? e.message : e}`
			});
		}

		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user.id,
			action: 'cache.rename',
			target: params.name,
			detail: newName
		});

		redirect(303, `/caches/${newName}/settings`);
	},

	delete: async ({ locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		await requireCachePermission(locals, platform.env.ATTIC_DB, 'cd', params.name, 'destroy cache');

		try {
			await destroyCache(platform.env, params.name);
		} catch (e) {
			return fail(502, { deleteError: `Failed to delete: ${e instanceof Error ? e.message : e}` });
		}

		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user.id,
			action: 'cache.destroy',
			target: params.name
		});

		redirect(303, '/caches');
	},

	accessAdd: async ({ request, locals, platform, params }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const form = await request.formData();
		const subject = String(form.get('subject') ?? '');
		const [subjectType, subjectId] = subject.split(':', 2) as [string, string | undefined];
		if ((subjectType !== 'user' && subjectType !== 'group') || !subjectId) {
			return fail(400, { accessError: 'Pick a user or group.' });
		}
		const actions = parseGrantActions(form);
		if (Object.keys(actions).length === 0) {
			return fail(400, { accessError: 'Pick at least one permission.' });
		}
		await insertGrant(db, {
			subjectType,
			subjectId,
			pattern: params.name,
			actions,
			actorId: locals.user!.id
		});
		return { accessSaved: true };
	},

	accessRemove: async ({ request, locals, platform, params }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const subjectType = String(form.get('subject_type') ?? '');
		const subjectId = String(form.get('subject_id') ?? '');
		if (subjectType !== 'user' && subjectType !== 'group') {
			return fail(400, { accessError: 'Invalid subject.' });
		}
		await removeGrantRow(db, id, subjectType, subjectId, locals.user!.id);
		return { accessSaved: true };
	}
};
