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
import { decodeSubject, encodeSubject, insertGrant, removeGrantRow } from '$lib/server/auth/grants';
import { effectiveAccessOf, requireAdmin, requireCachePermission } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { isValidPublicKey } from '$lib/server/attic/signing';
import {
	clearUpstreamsMemo,
	parseUpstreams,
	type StoredUpstream
} from '$lib/server/cache/missing-paths';
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

/**
 * Parse the form's JSON-serialized upstream rows ({url, key, ttlHours, mode},
 * all strings) into the stored shape. Blank rows are dropped; returns an
 * error string on the first invalid entry.
 */
function parseUpstreamForm(raw: string): { upstreams: StoredUpstream[] } | { error: string } {
	let rows: unknown;
	try {
		rows = JSON.parse(raw);
	} catch {
		return { error: 'Invalid upstream form data.' };
	}
	if (!Array.isArray(rows)) return { error: 'Invalid upstream form data.' };

	const upstreams: StoredUpstream[] = [];
	for (const row of rows) {
		const fields = (row ?? {}) as Record<string, unknown>;
		const url = String(fields.url ?? '')
			.trim()
			.replace(/\/+$/, '');
		const key = String(fields.key ?? '').trim();
		if (!url && !key) continue;
		if (!url) return { error: 'Each upstream needs a URL.' };
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
				return { error: `Upstream URL must be http(s): ${url}` };
			}
		} catch {
			return { error: `Invalid upstream URL: ${url}` };
		}
		if (key && !isValidPublicKey(key)) {
			return { error: `Invalid public key (expected name:base64…): ${key}` };
		}

		const ttlRaw = String(fields.ttlHours ?? '').trim();
		const ttlHours = ttlRaw === '' ? null : Number(ttlRaw);
		if (ttlHours !== null && (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 8760)) {
			return { error: `TTL must be between 1 hour and 1 year (in hours): ${ttlRaw}` };
		}

		upstreams.push({
			url,
			public_key: key || null,
			ttl: ttlHours === null ? null : Math.round(ttlHours * 3600),
			mode: fields.mode === 'persist' ? 'persist' : 'redirect'
		});
	}
	return { upstreams };
}

/**
 * The root proxy merges every cache's upstreams by URL, so two caches
 * declaring the same upstream with different trust keys is always a
 * misconfiguration (the merge would silently pick one). Reject it at save
 * time; differing ttl/mode merge fine (strictest wins) and pass.
 */
async function findUpstreamKeyConflict(
	db: App.Platform['env']['ATTIC_DB'],
	cacheName: string,
	upstreams: StoredUpstream[]
): Promise<string | null> {
	const keyed = upstreams.filter((u) => u.public_key);
	if (keyed.length === 0) return null;
	const { results } = await db
		.prepare('SELECT name, upstream_caches FROM cache WHERE deleted_at IS NULL AND name != ?1')
		.bind(cacheName)
		.all<{ name: string; upstream_caches: string }>();
	for (const row of results) {
		for (const other of parseUpstreams(row.upstream_caches)) {
			const mine = keyed.find((u) => u.url === other.url);
			if (mine && other.publicKey && mine.public_key !== other.publicKey) {
				return `Upstream ${mine.url} is declared by cache "${row.name}" with a different public key; keys for the same upstream must match.`;
			}
		}
	}
	return null;
}

/** Fetch rows by id when the caller has a specific id list (non-admin label
 *  lookups); avoids shipping whole tables for a handful of labels. */
async function rowsByIds<T>(
	db: App.Platform['env']['ATTIC_DB'],
	selectSql: string,
	ids: string[]
): Promise<T[]> {
	if (ids.length === 0) return [];
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(`${selectSql} WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<T>();
	return results;
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

	const [cache, access] = await Promise.all([
		getCache(env.ATTIC_DB, params.name),
		effectiveAccessOf(locals, env.ATTIC_DB)
	]);
	const canConfigure = canOnCache(access, 'cr', params.name);
	const canDestroy = canOnCache(access, 'cd', params.name);
	// Settings is a management surface: pull-only users have nothing to do here.
	if (!canConfigure && !canDestroy) throw error(403, 'Permission denied');

	const isAdmin = locals.user!.role === 'admin';
	const [roots, grantRows, adminUsers, adminGroups] = await Promise.all([
		listGcRoots(env, cache.id),
		// Only this cache's exact-name rows and glob rows can apply here (see
		// partitionCacheGrants) — other caches' exact grants never match.
		env.ATTIC_DB.prepare(
			`SELECT id, subject_type, subject_id, pattern, actions FROM permission_grant
			 WHERE pattern = ?1 OR pattern GLOB '*[*?]*'`
		)
			.bind(params.name)
			.all<CacheGrantRow>(),
		// Admins get the full lists (they also feed the add-access picker).
		isAdmin
			? env.ATTIC_DB.prepare('SELECT id, name, email FROM user ORDER BY name').all<{
					id: string;
					name: string;
					email: string;
				}>()
			: null,
		isAdmin
			? env.ATTIC_DB.prepare('SELECT id, name FROM groups ORDER BY name').all<{
					id: string;
					name: string;
				}>()
			: null
	]);

	const { direct, viaPatterns } = partitionCacheGrants(grantRows.results, params.name);
	const applicable = [...direct, ...viaPatterns];

	// Emails are admin-only PII; non-admin viewers see display names, resolved
	// only for the subjects that actually appear on this page.
	const subjectIds = (type: string) => [
		...new Set(applicable.filter((g) => g.subject_type === type).map((g) => g.subject_id))
	];
	const [users, groupRows] = isAdmin
		? [adminUsers!.results, adminGroups!.results]
		: await Promise.all([
				rowsByIds<{ id: string; name: string; email: string }>(
					env.ATTIC_DB,
					'SELECT id, name, email FROM user',
					subjectIds('user')
				),
				rowsByIds<{ id: string; name: string }>(
					env.ATTIC_DB,
					'SELECT id, name FROM groups',
					subjectIds('group')
				)
			]);
	const userLabel = new Map(users.map((u) => [u.id, isAdmin ? `${u.name} (${u.email})` : u.name]));
	const groupLabel = new Map(groupRows.map((g) => [g.id, g.name]));
	const subjectLabel = (g: CacheGrantRow) =>
		(g.subject_type === 'user' ? userLabel.get(g.subject_id) : groupLabel.get(g.subject_id)) ??
		g.subject_id;
	const describe = (g: CacheGrantRow) => ({
		id: g.id,
		subjectType: g.subject_type,
		subjectId: g.subject_id,
		subjectLabel: subjectLabel(g),
		pattern: g.pattern,
		actions: g.actions
	});

	// Form-ready rows (all strings) so the component can edit them directly.
	const upstreams = parseUpstreams(cache.upstream_caches).map((u) => ({
		url: u.url,
		key: u.publicKey ?? '',
		ttlHours: u.ttl === null ? '' : String(Math.round(u.ttl / 3600)),
		mode: u.mode
	}));

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
		permissions: { canConfigure, canDestroy },
		isAdmin,
		// Direct (exact-name, editable here) rows first, then read-only rows
		// contributed by glob patterns.
		access: [
			...direct.map((g) => ({ ...describe(g), direct: true })),
			...viaPatterns.map((g) => ({ ...describe(g), direct: false }))
		],
		subjects: isAdmin
			? [
					...users.map((u) => ({
						value: encodeSubject('user', u.id),
						label: `${u.name} (${u.email})`
					})),
					...groupRows.map((g) => ({
						value: encodeSubject('group', g.id),
						label: `${g.name} (group)`
					}))
				]
			: []
	};
};

export const actions: Actions = {
	save: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		await requireCachePermission(
			locals,
			platform.env.ATTIC_DB,
			'cr',
			params.name,
			'configure cache'
		);

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

		const parsed = parseUpstreamForm(String(form.get('upstreams') ?? '[]'));
		if ('error' in parsed) return fail(400, { error: parsed.error });
		const upstreams = parsed.upstreams;
		const conflict = await findUpstreamKeyConflict(platform.env.ATTIC_DB, params.name, upstreams);
		if (conflict) return fail(400, { error: conflict });

		try {
			await configureCache(platform.env, params.name, {
				is_public: isPublic,
				priority,
				compression,
				retention_period: retention,
				retention_max_bytes: maxBytes
			});
		} catch (e) {
			const status = e instanceof CacheConfigError ? e.status : 502;
			return fail(status, { error: `Failed to save: ${e instanceof Error ? e.message : e}` });
		}

		// The one column configureCache doesn't cover.
		await platform.env.ATTIC_DB.prepare('UPDATE cache SET upstream_caches = ?1 WHERE name = ?2')
			.bind(JSON.stringify(upstreams), params.name)
			.run();
		// Single-isolate coherence; other isolates converge within the memo TTL.
		clearUpstreamsMemo();

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

		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');

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

		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');

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

		// Renaming is a configure on the source. Claiming the target name needs
		// no extra permission — cache creation is open to any active user, and
		// renameCache 409s if the name is taken.
		await requireCachePermission(
			locals,
			platform.env.ATTIC_DB,
			'cr',
			params.name,
			'configure cache'
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
		const subject = decodeSubject(String(form.get('subject') ?? ''));
		if (!subject) return fail(400, { accessError: 'Pick a user or group.' });
		const actions = parseGrantActions(form);
		if (Object.keys(actions).length === 0) {
			return fail(400, { accessError: 'Pick at least one permission.' });
		}
		await insertGrant(db, {
			subjectType: subject.type,
			subjectId: subject.id,
			pattern: params.name,
			actions,
			actorId: locals.user!.id
		});
		return { accessSaved: true };
	},

	accessRemove: async ({ request, locals, platform }) => {
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
