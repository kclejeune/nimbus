import { error, fail, redirect } from '@sveltejs/kit';
import {
	CacheConfigError,
	configureCache,
	destroyCache,
	renameCache
} from '$lib/server/cache/cache-config';
import { requireCachePermission } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { formatDuration } from '$lib/duration';
import { gibFieldToBytes } from '$lib/format';
import { type UpstreamMode } from '$lib/server/cache/missing-paths';
import {
	cacheUpstreamOverrides,
	listRegistry,
	setCacheUpstreamModes
} from '$lib/server/cache/upstream-registry';
import { CACHE_NAME_HINT, CACHE_NAME_RE } from '$lib/utils';
import { getCache, requireCacheManage } from '$lib/server/cache/cache-page';
import type { PageServerLoad, Actions } from './$types';

/** The form's per-upstream mode selection: an override or 'inherit'. */
function parseModeField(raw: FormDataEntryValue | null): UpstreamMode | 'inherit' | null {
	const value = String(raw ?? 'inherit');
	if (value === 'inherit' || value === 'off' || value === 'redirect' || value === 'persist') {
		return value;
	}
	return null;
}

export const load: PageServerLoad = async ({ platform, params, locals }) => {
	const env = platform?.env;
	if (!env) throw error(500, 'Platform bindings unavailable');

	// The cache's settings and the viewer's bits come from the [name] layout
	// (cacheHeader, cacheViewer); this only adds the upstream picker.
	const { cache } = await requireCacheManage(locals, env.ATTIC_DB, params.name);

	const [registry, overrides] = await Promise.all([
		listRegistry(env.ATTIC_DB),
		cacheUpstreamOverrides(env.ATTIC_DB, cache.id)
	]);

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

	return { upstreams };
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
					error: `${entry.url} is enforced and can’t be turned off.`
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

	rename: async ({ request, locals, platform, params }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const newName = String((await request.formData()).get('new_name') ?? '').trim();

		if (!CACHE_NAME_RE.test(newName)) {
			return fail(400, {
				renameError: `Invalid name. ${CACHE_NAME_HINT}`
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
	}
};
