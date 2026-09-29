// Shared by the per-cache admin routes (/caches/[name]/…): the cache row
// lookup, the browse/manage guards, and form-field parsing their loads and
// actions have in common.
import { error } from '@sveltejs/kit';
import { findCache, STORE_PATH_HASH_RE, type CacheRow } from '$lib/server/cache/db';
import { canBrowseCache, canOnCache, type EffectiveAccess } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';

type DB = App.Platform['env']['ATTIC_DB'];

/** The live (not deleted) cache named `name`, or a 404. Actions call this
 *  directly: they run before a mutation, so they must not seed the memo. */
export async function getCache(db: DB, name: string): Promise<CacheRow> {
	const cache = await findCache(db, name);
	if (!cache) throw error(404, `Cache "${name}" not found`);
	return cache;
}

export interface BrowsableCache {
	id: number;
	name: string;
	is_public: number;
	retention_max_bytes: number | null;
}

/**
 * Every live cache the viewer may browse — public ones plus anything granted
 * (canBrowseCache) — and their access. The cross-cache read surfaces (the
 * overview, ⌘K search, /paths) bind their queries to these ids, so a private
 * cache without a grant is both invisible and unqueryable. The /caches
 * management table deliberately stays grant-only (canSeeCache).
 */
export async function browsableCaches(
	locals: App.Locals,
	db: DB,
	read: DB
): Promise<{ caches: BrowsableCache[]; access: EffectiveAccess }> {
	const [{ results }, access] = await Promise.all([
		read
			.prepare(
				`SELECT id, name, is_public, retention_max_bytes FROM cache
				 WHERE deleted_at IS NULL ORDER BY name`
			)
			.all<BrowsableCache>(),
		effectiveAccessOf(locals, db)
	]);
	return {
		caches: results.filter((c) =>
			canBrowseCache(access, { name: c.name, isPublic: c.is_public !== 0 })
		),
		access
	};
}

/** What the viewer may do on this cache's management tabs. */
export function cacheViewer(access: EffectiveAccess, name: string) {
	const canConfigure = canOnCache(access, 'cr', name);
	const canDestroy = canOnCache(access, 'cd', name);
	return { canConfigure, canDestroy, canManage: canConfigure || canDestroy };
}

/**
 * Loads only: the cache row and the viewer's access, 403 unless they may
 * browse it (public, or any grant). Memoized per request on `locals`, so the
 * [name] layout and the tab's page load — which run concurrently — share one
 * lookup and one rule.
 */
export async function requireCacheBrowse(
	locals: App.Locals,
	db: DB,
	name: string
): Promise<{ cache: CacheRow; access: EffectiveAccess }> {
	const rows = (locals.cacheRows ??= new Map());
	let row = rows.get(name);
	if (!row) rows.set(name, (row = getCache(db, name)));
	const [cache, access] = await Promise.all([row, effectiveAccessOf(locals, db)]);
	if (!canBrowseCache(access, { name: cache.name, isPublic: cache.is_public !== 0 })) {
		throw error(403, 'Permission denied');
	}
	return { cache, access };
}

/** Loads of the management tabs (Pins, Access, Settings): pull-only users
 *  have nothing to do there. */
export async function requireCacheManage(locals: App.Locals, db: DB, name: string) {
	const { cache, access } = await requireCacheBrowse(locals, db, name);
	const viewer = cacheViewer(access, name);
	if (!viewer.canManage) throw error(403, 'Permission denied');
	return { cache, access, ...viewer };
}

/** Accepts a full store path, `<hash>-name`, or a bare 32-char hash. */
export function parseStorePathHash(raw: string): string | null {
	const base = raw.trim().split('/').pop() ?? '';
	const hash = base.slice(0, 32).toLowerCase();
	return STORE_PATH_HASH_RE.test(hash) ? hash : null;
}

/** The `IN` clause for rowsByIds' `?1`. */
export const IN_IDS = 'IN (SELECT value FROM json_each(?1))';

/** Fetch rows for a specific key list (label lookups) instead of shipping
 *  whole tables for a handful of labels. `sql` filters with `${IN_IDS}`: one
 *  JSON-array bind rather than a `?` per key, so D1's 100-parameter limit
 *  never applies however many keys a page names. */
export async function rowsByIds<T>(db: DB, sql: string, ids: string[]): Promise<T[]> {
	if (ids.length === 0) return [];
	const { results } = await db.prepare(sql).bind(JSON.stringify(ids)).all<T>();
	return results;
}
