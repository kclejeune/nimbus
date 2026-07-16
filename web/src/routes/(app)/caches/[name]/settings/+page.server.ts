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
import { formatDuration } from '$lib/duration';
import { gibFieldToBytes } from '$lib/format';
import { type UpstreamMode } from '$lib/server/cache/missing-paths';
import {
	cacheUpstreamOverrides,
	listRegistry,
	setCacheUpstreamModes
} from '$lib/server/cache/upstream-registry';
import {
	addGcRoot,
	PIN_NAME_RE,
	removeGcRoot,
	removePin,
	STORE_PATH_HASH_RE,
	upsertPin
} from '$lib/server/cache/db';
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
}

/** Accepts a full store path, `<hash>-name`, or a bare 32-char hash. */
function parseStorePathHash(raw: string): string | null {
	const base = raw.trim().split('/').pop() ?? '';
	const hash = base.slice(0, 32).toLowerCase();
	return STORE_PATH_HASH_RE.test(hash) ? hash : null;
}

/** The form's per-upstream mode selection: an override or 'inherit'. */
function parseModeField(raw: FormDataEntryValue | null): UpstreamMode | 'inherit' | null {
	const value = String(raw ?? 'inherit');
	if (value === 'inherit' || value === 'off' || value === 'redirect' || value === 'persist') {
		return value;
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
			        retention_max_bytes
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
	const [roots, registry, overrides, grantRows, adminUsers, adminGroups] = await Promise.all([
		listGcRoots(env, cache.id),
		listRegistry(env.ATTIC_DB),
		cacheUpstreamOverrides(env.ATTIC_DB, cache.id),
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

	// One row per registry entry: the picker chooses this cache's mode
	// (inherit/off/redirect/persist); trust fields are read-only here (the
	// registry is admin-managed on /upstreams).
	const upstreams = registry.map((u) => ({
		id: u.id,
		url: u.url,
		keyName: u.publicKey ? u.publicKey.split(':')[0] : null,
		ttl: formatDuration(u.ttl),
		defaultMode: u.defaultMode,
		enforced: u.enforced,
		mode: overrides.get(u.id) ?? ('inherit' as const)
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

		const db = platform.env.ATTIC_DB;
		const cache = await getCache(db, params.name);
		const isAdmin = locals.user.role === 'admin';

		const form = await request.formData();
		const isPublic = form.get('is_public') === 'on';
		const priority = Number(form.get('priority') ?? 40);
		const compression = String(form.get('compression') ?? 'zstd');
		const retentionRaw = String(form.get('retention_period') ?? '').trim();
		const retention = retentionRaw === '' ? null : Number(retentionRaw);

		// Visibility is trust-affecting (it opens anonymous reads): admins only.
		if (isPublic !== (cache.is_public === 1) && !isAdmin) {
			return fail(403, { error: 'Only admins can change cache visibility.' });
		}

		const maxBytes = gibFieldToBytes(form.get('retention_max_gib'));
		if (maxBytes === undefined) {
			return fail(400, { error: 'Size limit must be a positive number of GiB.' });
		}

		// Upstream mode picker: one field per registry entry. Enforced entries
		// cannot be turned off (resolve-time clamping makes 'off' harmless, but
		// reject it for honest feedback); enabling persist is trust-affecting
		// and enforced by setCacheUpstreamModes' witness — the 403 here is UX.
		const [registry, overrides] = await Promise.all([
			listRegistry(db),
			cacheUpstreamOverrides(db, cache.id)
		]);
		const modeChanges: { upstreamId: number; mode: UpstreamMode | null }[] = [];
		for (const entry of registry) {
			const field = form.get(`upstream_mode_${entry.id}`);
			if (field === null) continue; // not rendered (stale form) — leave as-is
			const selected = parseModeField(field);
			if (selected === null) return fail(400, { error: 'Invalid upstream mode.' });
			const current = overrides.get(entry.id) ?? 'inherit';
			if (selected === current) continue;
			if (entry.enforced && selected === 'off') {
				return fail(400, {
					error: `${entry.url} is enforced by the server and cannot be disabled.`
				});
			}
			if (selected === 'persist' && !isAdmin) {
				return fail(403, { error: 'Only admins can enable pull-through persistence.' });
			}
			modeChanges.push({
				upstreamId: entry.id,
				mode: selected === 'inherit' ? null : selected
			});
		}

		try {
			await configureCache(
				platform.env,
				params.name,
				{
					// Trust-affecting; only admins send it (configureCache verifies).
					...(isAdmin ? { is_public: isPublic } : {}),
					priority,
					compression,
					retention_period: retention,
					retention_max_bytes: maxBytes
				},
				{ trustAuthorized: isAdmin, ctx: platform.ctx }
			);
		} catch (e) {
			const status = e instanceof CacheConfigError ? e.status : 502;
			return fail(status, { error: `Failed to save: ${e instanceof Error ? e.message : e}` });
		}

		if (modeChanges.length > 0) {
			// Purges the cache's edge-cached upstream passthroughs itself.
			await setCacheUpstreamModes(db, cache.id, modeChanges, {
				allowPersist: isAdmin,
				ctx: platform.ctx,
				cacheName: params.name
			});
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
		const pinName = String(form.get('pin_name') ?? '').trim();
		if (pinName) {
			// Named pin: re-pinning the name adds a revision (cachix-style).
			if (!PIN_NAME_RE.test(pinName)) {
				return fail(400, { rootError: 'Pin names must have no whitespace (max 100 chars).' });
			}
			const keepRaw = String(form.get('keep_revisions') ?? '').trim();
			const keep = keepRaw === '' ? undefined : Number(keepRaw);
			if (keep !== undefined && (!Number.isInteger(keep) || keep <= 0)) {
				return fail(400, { rootError: 'Keep revisions must be a positive whole number.' });
			}
			await upsertPin(db, cache.id, pinName, hash, { keepRevisions: keep, note });
			return { rootAdded: true };
		}
		await addGcRoot(db, cache.id, hash, note);
		return { rootAdded: true };
	},

	removeRoot: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		await requireCachePermission(locals, db, 'cr', params.name, 'configure cache retention');

		const form = await request.formData();
		const cache = await getCache(db, params.name);
		const pinName = String(form.get('pin') ?? '').trim();
		if (pinName) {
			// Removes the named pin and its whole revision history.
			await removePin(db, cache.id, pinName);
			return { rootRemoved: true };
		}
		const hash = String(form.get('hash') ?? '');
		await removeGcRoot(db, cache.id, hash);
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
			await destroyCache(platform.env, params.name, platform.ctx);
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
