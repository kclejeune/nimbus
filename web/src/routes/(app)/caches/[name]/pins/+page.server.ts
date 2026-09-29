import { error, fail } from '@sveltejs/kit';
import { listGcRoots } from '$lib/server/cache/gc';
import { canOnCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf, requireCachePermission } from '$lib/server/auth/guard';
import {
	addGcRoot,
	GC_ROOT_NOTE_MAX_CHARS,
	PIN_KEEP_REVISIONS_MAX,
	PIN_NAME_RE,
	removeGcRoot,
	removePin,
	upsertPin
} from '$lib/server/cache/db';
import { getCache, parseStorePathHash } from '$lib/server/cache/cache-page';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, params, locals }) => {
	const env = platform?.env;
	if (!env) throw error(500, 'Platform bindings unavailable');

	const [cache, access] = await Promise.all([
		getCache(env.ATTIC_DB, params.name),
		effectiveAccessOf(locals, env.ATTIC_DB)
	]);
	const canConfigure = canOnCache(access, 'cr', params.name);
	const canDestroy = canOnCache(access, 'cd', params.name);
	// A management surface: pull-only users have nothing to do here.
	if (!canConfigure && !canDestroy) throw error(403, 'Permission denied');

	return { roots: await listGcRoots(env, cache.id), canPin: canConfigure };
};

export const actions: Actions = {
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
		if (note && note.length > GC_ROOT_NOTE_MAX_CHARS) {
			return fail(400, { rootError: `Notes are limited to ${GC_ROOT_NOTE_MAX_CHARS} characters.` });
		}
		const pinName = String(form.get('pin_name') ?? '').trim();
		if (pinName) {
			// Named pin: re-pinning the name adds a revision (cachix-style).
			if (!PIN_NAME_RE.test(pinName)) {
				return fail(400, { rootError: 'Pin names must have no whitespace (max 100 chars).' });
			}
			const keepRaw = String(form.get('keep_revisions') ?? '').trim();
			const keep = keepRaw === '' ? undefined : Number(keepRaw);
			if (
				keep !== undefined &&
				(!Number.isInteger(keep) || keep <= 0 || keep > PIN_KEEP_REVISIONS_MAX)
			) {
				return fail(400, {
					rootError: `Keep revisions must be a whole number from 1 to ${PIN_KEEP_REVISIONS_MAX}.`
				});
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
	}
};
