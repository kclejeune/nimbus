// Garbage collection, ported from the Rust worker's gc.rs and extended with
// closure-aware retention: an object survives if it is reachable from a fresh
// object or a gc_root, and per-cache size budgets evict least-recently-used
// closures (never individual paths out of a kept closure).
//
// Runs from the scheduled (cron) handler and the manual /_api/v1/gc trigger.
// Every sweep is idempotent; passes are ordered so each exposes work for the
// next (retention deletes objects -> orphans NARs -> orphans chunks -> R2).

import { chunkKey, PARAM_BATCH, runBatched } from './db';
import { type ExecutionContext } from './platform';
import { narinfoTag } from './store';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];

const ABANDONED_CACHE_GRACE_SECS = 7 * 24 * 60 * 60;
/** Upstream "absent" verdicts are rechecked after this long. "Present" rows
 * lazily expire per-upstream (cachedVerdicts applies the upstream's TTL);
 * the prune here only bounds table growth for rows never read again. */
const UPSTREAM_ABSENT_TTL_SECS = 24 * 60 * 60;
const UPSTREAM_PRESENT_TTL_SECS = 90 * 24 * 60 * 60;
const REF_SYNC_BATCH = 500;
const PURGE_TAG_BATCH = 100;
const R2_DELETE_BATCH = 1000;
/**
 * Doomed objects fetched per evaluation of the reachability CTE in the
 * retention sweep. Each evaluation pays the full closure computation, so this
 * is sized for one pass in the common case (~50k rows ≈ a few MB) while still
 * bounding Worker memory and the D1 response size on pathological sweeps.
 */
const GC_SWEEP = 50_000;
/**
 * Closure evictions per size-budget pass per run. Each round costs a handful
 * of D1 queries against the invocation's subrequest budget; a backlog beyond
 * the cap resumes on the next run.
 */
const MAX_EVICTION_ROUNDS = 50;
const MAX_GLOBAL_EVICTION_ROUNDS = 100;

export interface GcStats {
	abandoned_caches_reaped: number;
	detached_objects_reaped: number;
	expired_objects_reaped: number;
	size_evicted_objects: number;
	global_evicted_objects: number;
	orphan_nars_reaped: number;
	orphan_chunks_reaped: number;
	pin_revisions_pruned: number;
	/** Advisory: live objects whose References are neither local nor covered
	 * by an upstream verdict — closures Nix could fail to substitute. */
	incomplete_closure_objects: number;
	refs_synced: number;
	narinfo_tags_purged: number;
	[key: string]: number;
}

function emptyStats(): GcStats {
	return {
		abandoned_caches_reaped: 0,
		detached_objects_reaped: 0,
		expired_objects_reaped: 0,
		size_evicted_objects: 0,
		global_evicted_objects: 0,
		orphan_nars_reaped: 0,
		orphan_chunks_reaped: 0,
		pin_revisions_pruned: 0,
		incomplete_closure_objects: 0,
		refs_synced: 0,
		narinfo_tags_purged: 0
	};
}

export async function runGc(
	env: Env,
	opts: { dryRun?: boolean; ctx?: ExecutionContext; integrityReport?: boolean } = {}
): Promise<GcStats> {
	const stats = emptyStats();
	const dryRun = opts.dryRun ?? false;
	// Cache-Tags of deleted objects, purged from the edge cache at the end so
	// long-TTL narinfo entries stop being served once their storage is gone.
	const purgeTags: string[] = [];

	await syncObjectRefs(env.ATTIC_DB, stats);

	if (!dryRun) {
		await reapAbandonedCaches(env.ATTIC_DB, stats);
		// Expired pin revisions detach-unpin before retention runs, so this
		// sweep already treats them as ordinary unpinned paths.
		await prunePinRevisions(env.ATTIC_DB, stats);
	}
	await detachedPass(env.ATTIC_DB, stats, dryRun, purgeTags);
	await retentionPass(env.ATTIC_DB, stats, dryRun, purgeTags);
	await globalSizePass(env.ATTIC_DB, stats, dryRun, purgeTags);
	// Advisory only, and the heaviest read of the run — size-triggered GC
	// (upload hot path via waitUntil) opts out; cron and manual runs report.
	if (opts.integrityReport ?? true) {
		await closureIntegrityReport(env.ATTIC_DB, stats);
	}
	if (!dryRun) {
		await reapOrphans(env, stats);
		await env.ATTIC_DB.prepare('DELETE FROM device_auth WHERE expires_at < ?1')
			.bind(Math.floor(Date.now() / 1000))
			.run()
			.catch((e) => console.warn(`gc: device_auth cleanup failed: ${e}`));
		await pruneUpstreamChecks(env.ATTIC_DB);
		await refreshAllGcRootStats(env.ATTIC_DB);
		await purgeNarinfoTags(opts.ctx, purgeTags, stats);
	}

	return stats;
}

/**
 * Evict the narinfo of reaped objects from the edge cache. Purges are scoped
 * to the entrypoint that issues them, so this goes through the CachedStore
 * loopback — a purge from the gateway would target its own (empty) cache.
 * Best-effort: on failure the entries linger until their max-age expires.
 */
async function purgeNarinfoTags(
	ctx: ExecutionContext | undefined,
	tags: string[],
	stats: GcStats
): Promise<void> {
	if (tags.length > 0 && !ctx?.exports?.CachedStore) {
		console.warn(`gc: CachedStore unavailable; skipping purge of ${tags.length} narinfo tags`);
	}
	stats.narinfo_tags_purged += await purgeTagsBestEffort(ctx, tags);
}

/**
 * Best-effort edge purge (GC sweeps, path removal, settings saves); returns
 * the number of tags purged. Purges only affect the cache of the entrypoint
 * that issues them, so this goes through the CachedStore loopback — a purge
 * from the gateway would target its own (empty) cache. Batches run
 * sequentially on purpose: purge shares the zone purge API's rate limits.
 * On failure stale entries linger until their max-age expires.
 */
export async function purgeTagsBestEffort(
	ctx: ExecutionContext | undefined,
	tags: string[]
): Promise<number> {
	const store = ctx?.exports?.CachedStore;
	if (!store || tags.length === 0) return 0;
	let purged = 0;
	for (let i = 0; i < tags.length; i += PURGE_TAG_BATCH) {
		const batch = tags.slice(i, i + PURGE_TAG_BATCH);
		try {
			await store.purgeTags(batch);
			purged += batch.length;
		} catch (e) {
			console.warn(`edge purge failed (${batch.length} tags): ${e}`);
		}
	}
	return purged;
}

/**
 * Derive object_ref rows from object.refs JSON, in id windows so a single
 * statement never writes an unbounded number of rows. Also serves as the
 * initial backfill; the watermark makes reruns cheap.
 *
 * The processed high-water mark is persisted (server_config) rather than
 * derived from MAX(object_ref.object_id): a trailing run of refless objects
 * produces no ref rows, so a derived mark would sit below it forever and
 * every sync — each GC run and each path removal — would rescan that tail.
 * The persisted mark advances atomically with each window's batch (a
 * mid-run kill loses no progress) and only ever forward, so concurrent
 * syncs can't regress it; double-processing is harmless (INSERT OR IGNORE).
 * Missing key = fresh or pre-upgrade DB; fall back to the old derivation.
 *
 * child_id maintenance rides along: new edges resolve inline, and edges that
 * dangled because the referenced path had not been pushed yet resolve once an
 * object in the window supplies it. Closure CTEs traverse child_id, so they
 * only see edges this pass has processed — callers outside runGc
 * (detachClosure) must sync first.
 */
const REF_SYNC_WATERMARK_KEY = 'ref_sync_watermark';

export async function syncObjectRefs(db: D1, stats?: GcStats): Promise<void> {
	const bounds = await db
		.prepare(
			'SELECT COALESCE(' +
				`(SELECT CAST(value AS INTEGER) FROM server_config WHERE key = '${REF_SYNC_WATERMARK_KEY}'), ` +
				'(SELECT COALESCE(MAX(object_id), 0) FROM object_ref)) AS watermark, ' +
				'COALESCE((SELECT MAX(id) FROM object), 0) AS max_id'
		)
		.first<{ watermark: number; max_id: number }>();
	if (!bounds) return;

	for (let start = bounds.watermark; start < bounds.max_id; start += REF_SYNC_BATCH) {
		const end = start + REF_SYNC_BATCH;
		const results = await db.batch([
			db
				.prepare(
					'INSERT OR IGNORE INTO object_ref (object_id, ref_hash, child_id) ' +
						'SELECT o.id, substr(j.value, 1, 32), ' +
						'(SELECT o2.id FROM object o2 WHERE o2.cache_id = o.cache_id ' +
						'AND o2.store_path_hash = substr(j.value, 1, 32)) ' +
						'FROM object o, json_each(o.refs) j ' +
						'WHERE o.id > ?1 AND o.id <= ?2 ' +
						'AND length(j.value) >= 32 AND substr(j.value, 1, 32) <> o.store_path_hash'
				)
				.bind(start, end),
			// Objects in this window may be the missing children of older
			// dangling edges (pushes arrive in any order).
			db
				.prepare(
					'UPDATE object_ref SET child_id = (' +
						'SELECT o2.id FROM object o2 WHERE o2.store_path_hash = object_ref.ref_hash ' +
						'AND o2.id > ?1 AND o2.id <= ?2 ' +
						'AND o2.cache_id = (SELECT p.cache_id FROM object p WHERE p.id = object_ref.object_id)' +
						') WHERE child_id IS NULL AND EXISTS (' +
						'SELECT 1 FROM object o2 WHERE o2.store_path_hash = object_ref.ref_hash ' +
						'AND o2.id > ?1 AND o2.id <= ?2 ' +
						'AND o2.cache_id = (SELECT p.cache_id FROM object p WHERE p.id = object_ref.object_id))'
				)
				.bind(start, end),
			db
				.prepare(
					`INSERT INTO server_config (key, value) VALUES ('${REF_SYNC_WATERMARK_KEY}', ?1) ` +
						'ON CONFLICT (key) DO UPDATE SET value = excluded.value ' +
						'WHERE CAST(excluded.value AS INTEGER) > CAST(server_config.value AS INTEGER)'
				)
				.bind(String(Math.min(end, bounds.max_id)))
		]);
		if (stats) stats.refs_synced += results[0]?.meta.changes ?? 0;
	}
}

// --- Closure queries ---
//
// Reachability runs inside SQLite as recursive CTEs instead of materializing
// the object graph in Worker memory: a million-object cache would not fit in
// the 128 MB isolate heap, but is routine for a server-side table scan.
// Traversal walks object_ref.child_id — integer index steps, already resolved
// per cache by the ref-sync pass; NULL child_id means the referenced path is
// not in the cache and the edge is skipped.

/**
 * The recursive arm shared by every closure CTE: expand one step along
 * resolved object_ref edges. child_id-only traversal is load-bearing —
 * callers outside runGc must syncObjectRefs first (see its doc).
 */
const closureStep = (cte: string): string =>
	'  UNION' +
	`  SELECT r.child_id FROM ${cte} k` +
	'    JOIN object_ref r ON r.object_id = k.id' +
	'   WHERE r.child_id IS NOT NULL';

/**
 * Objects unreachable from any fresh object or gc_root, in id order after
 * `afterId`. A null cutoff treats every object as fresh (nothing expires).
 * Detached (removed) objects never seed the keep set — they survive only
 * while something live still reaches them.
 */
const UNREACHABLE_SQL =
	'WITH RECURSIVE keep(id) AS (' +
	'  SELECT id FROM object' +
	'   WHERE cache_id = ?1 AND (' +
	'     ((?2 IS NULL OR COALESCE(last_accessed_at, created_at) >= ?2) AND detached_at IS NULL)' +
	'     OR store_path_hash IN (SELECT store_path_hash FROM gc_root WHERE cache_id = ?1)' +
	'   )' +
	closureStep('keep') +
	') ' +
	'SELECT o.id, o.store_path_hash FROM object o' +
	' WHERE o.cache_id = ?1 AND o.id > ?3 AND o.id NOT IN (SELECT id FROM keep)' +
	' ORDER BY o.id LIMIT ?4';

/**
 * Detached objects nothing live can reach: not reachable from any
 * non-detached object nor from a gc_root closure. These are the rows the
 * removal actually deletes — everything else detached is still someone's
 * dependency and keeps serving until its last referrer goes.
 */
const REAP_DETACHED_SQL =
	'WITH RECURSIVE keep(id) AS (' +
	'  SELECT id FROM object' +
	'   WHERE cache_id = ?1 AND (' +
	'     detached_at IS NULL' +
	'     OR store_path_hash IN (SELECT store_path_hash FROM gc_root WHERE cache_id = ?1)' +
	'   )' +
	closureStep('keep') +
	') ' +
	'SELECT o.id, o.store_path_hash FROM object o' +
	' WHERE o.cache_id = ?1 AND o.detached_at IS NOT NULL' +
	'   AND o.id NOT IN (SELECT id FROM keep)';

/**
 * The exclusive closure of a store path: closure(target) minus everything
 * still reachable from objects outside the closure or from gc_roots. These
 * are the rows that become garbage if the target is evicted. Detached
 * objects don't anchor here either (same rule as UNREACHABLE_SQL): a
 * removed-but-not-yet-reaped straggler must not protect closure members
 * from size eviction.
 */
const EXCLUSIVE_CLOSURE_SQL =
	'WITH RECURSIVE target(id) AS (' +
	'  SELECT id FROM object WHERE cache_id = ?1 AND store_path_hash = ?2' +
	closureStep('target') +
	'), keep(id) AS (' +
	'  SELECT o.id FROM object o' +
	'   WHERE o.cache_id = ?1 AND (' +
	'     (o.id NOT IN (SELECT id FROM target) AND o.detached_at IS NULL)' +
	'     OR o.store_path_hash IN (SELECT store_path_hash FROM gc_root WHERE cache_id = ?1)' +
	'   )' +
	closureStep('keep') +
	') ' +
	'SELECT o.id, o.store_path_hash FROM object o' +
	' WHERE o.id IN (SELECT id FROM target) AND o.id NOT IN (SELECT id FROM keep)';

/**
 * Least-recently-used top-level object in a cache: referenced by nothing else
 * in the cache and not protected by a gc_root closure. child_id is resolved
 * within one cache, so the referrer check needs no cache filter. (Detached
 * top-level objects can't appear here: the detached pass runs first and a
 * detached object with no referrers is reaped by it.)
 */
const OLDEST_TOP_LEVEL_SQL =
	'WITH RECURSIVE protected(id) AS (' +
	'  SELECT o.id FROM object o' +
	'    JOIN gc_root g ON g.cache_id = ?1 AND g.store_path_hash = o.store_path_hash' +
	'   WHERE o.cache_id = ?1' +
	closureStep('protected') +
	') ' +
	'SELECT o.id, o.store_path_hash FROM object o' +
	' WHERE o.cache_id = ?1' +
	'   AND o.id NOT IN (SELECT id FROM protected)' +
	'   AND NOT EXISTS (' +
	'     SELECT 1 FROM object_ref r WHERE r.child_id = o.id AND r.object_id <> o.id' +
	'   )' +
	' ORDER BY COALESCE(o.last_accessed_at, o.created_at) ASC LIMIT 1';

/** Deduplicated NAR bytes attributed to a cache (distinct nars, summed). */
const CACHE_SIZE_SQL =
	'SELECT COALESCE(SUM(sz.bytes), 0) AS n ' +
	'FROM (SELECT DISTINCT nar_id FROM object WHERE cache_id = ?1) o ' +
	'JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr ' +
	'JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz ON sz.nar_id = o.nar_id';

interface DoomedRow {
	id: number;
	store_path_hash: string;
}

/**
 * Closure-aware retention per cache. Runs only for caches with a time window
 * or size budget configured. An object survives while it is reachable from a
 * fresh object or a gc_root; over-budget caches then evict least-recently-used
 * top-level closures (never individual paths out of a kept closure).
 */
async function retentionPass(
	db: D1,
	stats: GcStats,
	dryRun: boolean,
	purgeTags: string[]
): Promise<void> {
	const caches = (
		await db
			.prepare(
				'SELECT id, name, retention_period, retention_max_bytes FROM cache ' +
					'WHERE deleted_at IS NULL AND (retention_period IS NOT NULL OR retention_max_bytes IS NOT NULL)'
			)
			.all<{
				id: number;
				name: string;
				retention_period: number | null;
				retention_max_bytes: number | null;
			}>()
	).results;

	for (const cache of caches) {
		try {
			if (cache.retention_period != null) {
				const cutoff = new Date(
					Date.now() - cache.retention_period * 24 * 60 * 60 * 1000
				).toISOString();
				stats.expired_objects_reaped += await reapUnreachable(
					db,
					cache.id,
					cache.name,
					cutoff,
					dryRun,
					purgeTags
				);
			}
			if (cache.retention_max_bytes != null) {
				stats.size_evicted_objects += await evictCacheToBudget(db, cache, dryRun, purgeTags);
			}
		} catch (e) {
			console.warn(`gc: retention pass failed for cache ${cache.name}: ${e}`);
		}
	}
}

/** Delete (or count, when dry) everything unreachable from fresh/root objects. */
async function reapUnreachable(
	db: D1,
	cacheId: number,
	cacheName: string,
	cutoff: string,
	dryRun: boolean,
	purgeTags: string[]
): Promise<number> {
	let reaped = 0;
	let afterId = 0;
	for (;;) {
		const sweep = (
			await db.prepare(UNREACHABLE_SQL).bind(cacheId, cutoff, afterId, GC_SWEEP).all<DoomedRow>()
		).results;
		if (sweep.length === 0) return reaped;
		afterId = sweep[sweep.length - 1].id;
		if (!dryRun) {
			await deleteObjects(
				db,
				sweep.map((o) => o.id)
			);
			purgeTags.push(...sweep.map((o) => narinfoTag(cacheName, o.store_path_hash)));
		}
		reaped += sweep.length;
		if (sweep.length < GC_SWEEP) return reaped;
	}
}

/**
 * Evict least-recently-used top-level closures until the cache fits its size
 * budget. gc_root closures are exempt (the budget can be exceeded by pins
 * alone). Dry runs report a single round: without deleting, the measured size
 * never drops.
 */
async function evictCacheToBudget(
	db: D1,
	cache: { id: number; name: string; retention_max_bytes: number | null },
	dryRun: boolean,
	purgeTags: string[]
): Promise<number> {
	const budget = cache.retention_max_bytes ?? Infinity;
	let evicted = 0;
	for (let round = 0; round < MAX_EVICTION_ROUNDS; round++) {
		const size = (await db.prepare(CACHE_SIZE_SQL).bind(cache.id).first<{ n: number }>())?.n ?? 0;
		if (size <= budget) break;
		const victim = await db.prepare(OLDEST_TOP_LEVEL_SQL).bind(cache.id).first<DoomedRow>();
		if (!victim) {
			console.warn(`gc: cache ${cache.name} over size budget with only protected closures left`);
			break;
		}
		const doomed = (
			await db
				.prepare(EXCLUSIVE_CLOSURE_SQL)
				.bind(cache.id, victim.store_path_hash)
				.all<DoomedRow>()
		).results;
		if (doomed.length === 0) break;
		evicted += doomed.length;
		if (dryRun) break;
		await deleteObjects(
			db,
			doomed.map((d) => d.id)
		);
		purgeTags.push(...doomed.map((d) => narinfoTag(cache.name, d.store_path_hash)));
	}
	return evicted;
}

/**
 * Delete object rows plus their outgoing edges, and un-resolve incoming edges
 * from surviving parents (the ref_hash stays; child_id re-resolves if the
 * path is pushed again). All clears run before any delete so a crash between
 * batches can only leave NULL child_ids awaiting re-resolution, never a
 * child_id pointing at a dead row (which would pin the edge dangling forever
 * since AUTOINCREMENT never reuses the id).
 */
async function deleteObjects(db: D1, ids: number[]): Promise<void> {
	const stmts = [];
	for (let i = 0; i < ids.length; i += PARAM_BATCH) {
		const batch = ids.slice(i, i + PARAM_BATCH);
		const placeholders = batch.map((_, j) => `?${j + 1}`).join(', ');
		stmts.push(
			db
				.prepare(`UPDATE object_ref SET child_id = NULL WHERE child_id IN (${placeholders})`)
				.bind(...batch)
		);
	}
	for (let i = 0; i < ids.length; i += PARAM_BATCH) {
		const batch = ids.slice(i, i + PARAM_BATCH);
		const placeholders = batch.map((_, j) => `?${j + 1}`).join(', ');
		stmts.push(
			db.prepare(`DELETE FROM object_ref WHERE object_id IN (${placeholders})`).bind(...batch),
			db.prepare(`DELETE FROM object WHERE id IN (${placeholders})`).bind(...batch)
		);
	}
	await runBatched(db, stmts);
}

/** LRU top-level object across all caches, gc_root closures exempt. */
const GLOBAL_OLDEST_TOP_LEVEL_SQL =
	'WITH RECURSIVE protected(id) AS (' +
	'  SELECT o.id FROM object o' +
	'    JOIN gc_root g ON g.cache_id = o.cache_id AND g.store_path_hash = o.store_path_hash' +
	closureStep('protected') +
	') ' +
	'SELECT o.id, o.cache_id AS cache_id, o.store_path_hash, c.name AS cache_name' +
	'  FROM object o JOIN cache c ON c.id = o.cache_id AND c.deleted_at IS NULL' +
	' WHERE NOT EXISTS (SELECT 1 FROM protected p WHERE p.id = o.id)' +
	'   AND NOT EXISTS (' +
	'     SELECT 1 FROM object_ref r WHERE r.child_id = o.id AND r.object_id <> o.id' +
	'   )' +
	' ORDER BY COALESCE(o.last_accessed_at, o.created_at) ASC LIMIT 1';

/**
 * Valid chunk bytes still reachable through some object, i.e. what the orphan
 * pass cannot reclaim. The working measure inside the eviction loop: a NAR's
 * bytes only stop counting once its last object (in any cache) is gone, so
 * paths shared with another cache never free storage.
 */
const REFERENCED_CHUNK_BYTES_SQL =
	'SELECT COALESCE(SUM(ch.file_size), 0) AS n FROM chunk ch ' +
	"WHERE ch.state = 'V' AND EXISTS (" +
	'SELECT 1 FROM chunkref cr JOIN object o ON o.nar_id = cr.nar_id WHERE cr.chunk_id = ch.id)';

/**
 * Global physical-storage ceiling (server_config.global_max_bytes): when total
 * deduplicated chunk bytes exceed the limit, evict least-recently-used
 * top-level closures across ALL caches until under it. gc_root closures are
 * exempt. Dry runs report a single round: without deleting, the measured
 * total never drops.
 */
async function globalSizePass(
	db: D1,
	stats: GcStats,
	dryRun: boolean,
	purgeTags: string[]
): Promise<void> {
	const limitRow = await db
		.prepare("SELECT value FROM server_config WHERE key = 'global_max_bytes'")
		.first<{ value: string }>();
	const limit = limitRow ? Number(limitRow.value) : NaN;
	if (!Number.isFinite(limit) || limit <= 0) return;

	const totalRow = await db
		.prepare("SELECT COALESCE(SUM(file_size), 0) AS n FROM chunk WHERE state = 'V'")
		.first<{ n: number }>();
	if ((totalRow?.n ?? 0) <= limit) return;

	let over = true;
	for (let round = 0; round < MAX_GLOBAL_EVICTION_ROUNDS; round++) {
		const total = (await db.prepare(REFERENCED_CHUNK_BYTES_SQL).first<{ n: number }>())?.n ?? 0;
		over = total > limit;
		if (!over) break;
		const victim = await db
			.prepare(GLOBAL_OLDEST_TOP_LEVEL_SQL)
			.first<{ id: number; cache_id: number; store_path_hash: string; cache_name: string }>();
		if (!victim) break;
		const doomed = (
			await db
				.prepare(EXCLUSIVE_CLOSURE_SQL)
				.bind(victim.cache_id, victim.store_path_hash)
				.all<DoomedRow>()
		).results;
		if (doomed.length === 0) break;
		stats.global_evicted_objects += doomed.length;
		if (dryRun) return;
		await deleteObjects(
			db,
			doomed.map((d) => d.id)
		);
		purgeTags.push(...doomed.map((d) => narinfoTag(victim.cache_name, d.store_path_hash)));
	}
	if (over) {
		console.warn('gc: still over global limit after eviction pass');
	}
}

export interface GcRootInfo {
	hash: string;
	note: string | null;
	/** Named pin this row is a revision of; null for anonymous quick pins. */
	pinName: string | null;
	keepRevisions: number | null;
	createdAt: string;
	/** False when no live object matches the pinned hash (pin has no effect). */
	inCache: boolean;
	closureObjects: number;
	closureBytes: number;
}

/** Object count and deduplicated NAR bytes of one store path's closure. */
const CLOSURE_STATS_SQL =
	'WITH RECURSIVE cl(id) AS (' +
	'  SELECT id FROM object WHERE cache_id = ?1 AND store_path_hash = ?2' +
	closureStep('cl') +
	') ' +
	'SELECT (SELECT COUNT(*) FROM cl) AS objects, ' +
	'COALESCE((SELECT SUM(ch.file_size) FROM chunk ch ' +
	'JOIN chunkref cr ON cr.chunk_id = ch.id ' +
	'WHERE cr.nar_id IN (SELECT DISTINCT o.nar_id FROM object o ' +
	'WHERE o.id IN (SELECT id FROM cl))), 0) AS bytes';

/** Compute and persist one root's closure stats; returns them. */
async function refreshGcRootStats(
	db: D1,
	cacheId: number,
	hash: string
): Promise<{ objects: number; bytes: number }> {
	const row = await db
		.prepare(CLOSURE_STATS_SQL)
		.bind(cacheId, hash)
		.first<{ objects: number; bytes: number }>();
	const stats = { objects: row?.objects ?? 0, bytes: row?.bytes ?? 0 };
	await db
		.prepare(
			'UPDATE gc_root SET closure_objects = ?1, closure_bytes = ?2, stats_at = ?3 ' +
				'WHERE cache_id = ?4 AND store_path_hash = ?5'
		)
		.bind(stats.objects, stats.bytes, new Date().toISOString(), cacheId, hash)
		.run();
	return stats;
}

/** Refresh the cached closure stats of every root (a handful of rows). */
async function refreshAllGcRootStats(db: D1): Promise<void> {
	const roots = (
		await db.prepare('SELECT cache_id, store_path_hash FROM gc_root').all<{
			cache_id: number;
			store_path_hash: string;
		}>()
	).results;
	await Promise.all(
		roots.map((root) =>
			refreshGcRootStats(db, root.cache_id, root.store_path_hash).catch((e) =>
				console.warn(`gc: root stats refresh failed for ${root.store_path_hash}: ${e}`)
			)
		)
	);
}

/**
 * GC roots for a cache, each with the size of the closure it protects. Serves
 * the stats cached by the GC refresh; a root without stats (fresh pin) or
 * with an empty closure (pin not yet effective — the empty-closure query is
 * cheap) is recomputed inline so state changes show up without waiting for
 * the nightly run.
 */
export async function listGcRoots(env: Env, cacheId: number): Promise<GcRootInfo[]> {
	const db = env.ATTIC_DB;
	const roots = (
		await db
			.prepare(
				'SELECT g.store_path_hash, g.note, g.created_at, g.closure_objects, g.closure_bytes, ' +
					'g.stats_at, p.name AS pin_name, p.keep_revisions ' +
					'FROM gc_root g LEFT JOIN pin p ON p.id = g.pin_id ' +
					'WHERE g.cache_id = ?1 ORDER BY p.name IS NULL, p.name, g.created_at DESC'
			)
			.bind(cacheId)
			.all<{
				store_path_hash: string;
				note: string | null;
				created_at: string;
				closure_objects: number | null;
				closure_bytes: number | null;
				stats_at: string | null;
				pin_name: string | null;
				keep_revisions: number | null;
			}>()
	).results;

	return Promise.all(
		roots.map(async (root) => {
			let objects = root.closure_objects ?? 0;
			let bytes = root.closure_bytes ?? 0;
			if (root.stats_at == null || objects === 0) {
				({ objects, bytes } = await refreshGcRootStats(db, cacheId, root.store_path_hash));
			}
			return {
				hash: root.store_path_hash,
				note: root.note,
				pinName: root.pin_name,
				keepRevisions: root.keep_revisions,
				createdAt: root.created_at,
				inCache: objects > 0,
				closureObjects: objects,
				closureBytes: bytes
			};
		})
	);
}

export interface PinInfo {
	name: string;
	keepRevisions: number | null;
	keepDays: number | null;
	/** Newest first; the first entry is the current revision. */
	revisions: { hash: string; createdAt: string; note: string | null }[];
}

/** Named pins with their revision history (the /pin API's list shape). */
export async function listPins(env: Env, cacheId: number): Promise<PinInfo[]> {
	const { results } = await env.ATTIC_DB.prepare(
		'SELECT p.name, p.keep_revisions, p.keep_days, g.store_path_hash, g.created_at, g.note ' +
			'FROM pin p LEFT JOIN gc_root g ON g.pin_id = p.id ' +
			'WHERE p.cache_id = ?1 ORDER BY p.name, g.created_at DESC, g.id DESC'
	)
		.bind(cacheId)
		.all<{
			name: string;
			keep_revisions: number | null;
			keep_days: number | null;
			store_path_hash: string | null;
			created_at: string | null;
			note: string | null;
		}>();
	const pins = new Map<string, PinInfo>();
	for (const row of results) {
		let pin = pins.get(row.name);
		if (!pin) {
			pin = {
				name: row.name,
				keepRevisions: row.keep_revisions,
				keepDays: row.keep_days,
				revisions: []
			};
			pins.set(row.name, pin);
		}
		if (row.store_path_hash) {
			pin.revisions.push({
				hash: row.store_path_hash,
				createdAt: row.created_at ?? '',
				note: row.note
			});
		}
	}
	return [...pins.values()];
}

/** The full closure of one store path within a cache (ids only). */
const CLOSURE_IDS_SQL =
	'WITH RECURSIVE cl(id) AS (' +
	'  SELECT id FROM object WHERE cache_id = ?1 AND store_path_hash = ?2' +
	closureStep('cl') +
	') SELECT id FROM cl';

/**
 * Remove a store path: mark its closure detached, then immediately reap
 * whatever nothing live can still reach (with an edge purge). Removal never
 * breaks another path's closure — detached-but-referenced objects keep
 * serving and are reaped by later GC runs once their last referrer goes.
 * Pinned paths are left alone (unpin first). Returns detached/reaped counts.
 */
export async function detachClosure(
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheId: number,
	cacheName: string,
	hash: string
): Promise<{ detached: number; reaped: number }> {
	const db = env.ATTIC_DB;
	// Closure CTEs only see edges the ref-sync pass has processed; sync first
	// so recently pushed objects are linked (watermark makes this cheap).
	await syncObjectRefs(db);
	const marked = await db
		.prepare(
			`UPDATE object SET detached_at = ?3 WHERE id IN (${CLOSURE_IDS_SQL}) ` +
				'AND detached_at IS NULL ' +
				'AND store_path_hash NOT IN (SELECT store_path_hash FROM gc_root WHERE cache_id = ?1)'
		)
		.bind(cacheId, hash, new Date().toISOString())
		.run();

	const tags = await reapDetachedForCache(db, cacheId, cacheName);
	await purgeTagsBestEffort(ctx, tags);
	return { detached: marked.meta.changes ?? 0, reaped: tags.length };
}

/**
 * Delete the reapable detached objects of one cache and return the narinfo
 * tags of what was deleted — the delete+purge pairing every caller must
 * uphold (detachClosure purges immediately; the GC pass batches).
 */
async function reapDetachedForCache(db: D1, cacheId: number, cacheName: string): Promise<string[]> {
	const doomed = (await db.prepare(REAP_DETACHED_SQL).bind(cacheId).all<DoomedRow>()).results;
	if (doomed.length === 0) return [];
	await deleteObjects(
		db,
		doomed.map((d) => d.id)
	);
	return doomed.map((d) => narinfoTag(cacheName, d.store_path_hash));
}

/**
 * Reap detached objects whose last live referrer has since disappeared —
 * stragglers detachClosure could not delete at removal time.
 */
async function detachedPass(
	db: D1,
	stats: GcStats,
	dryRun: boolean,
	purgeTags: string[]
): Promise<void> {
	const caches = (
		await db
			.prepare(
				'SELECT DISTINCT c.id, c.name FROM object o JOIN cache c ON c.id = o.cache_id ' +
					'WHERE o.detached_at IS NOT NULL AND c.deleted_at IS NULL'
			)
			.all<{ id: number; name: string }>()
	).results;
	for (const cache of caches) {
		try {
			if (dryRun) {
				const doomed = (await db.prepare(REAP_DETACHED_SQL).bind(cache.id).all<DoomedRow>())
					.results;
				stats.detached_objects_reaped += doomed.length;
				continue;
			}
			const tags = await reapDetachedForCache(db, cache.id, cache.name);
			stats.detached_objects_reaped += tags.length;
			purgeTags.push(...tags);
		} catch (e) {
			console.warn(`gc: detached pass failed for cache ${cache.name}: ${e}`);
		}
	}
}

/**
 * Enforce keep_revisions / keep_days on named pins: revisions beyond the
 * limits are unpinned (their gc_root rows deleted). The current (newest)
 * revision is never pruned; unpinned paths then age out via normal retention.
 */
async function prunePinRevisions(db: D1, stats: GcStats): Promise<void> {
	try {
		const result = await db
			.prepare(
				'DELETE FROM gc_root WHERE id IN (' +
					'SELECT id FROM (' +
					'  SELECT g.id, g.created_at, p.keep_revisions, p.keep_days,' +
					'         ROW_NUMBER() OVER (PARTITION BY g.pin_id ORDER BY g.created_at DESC, g.id DESC) AS rn' +
					'  FROM gc_root g JOIN pin p ON p.id = g.pin_id' +
					') WHERE rn > 1 AND (' +
					'  (keep_revisions IS NOT NULL AND rn > keep_revisions)' +
					"  OR (keep_days IS NOT NULL AND datetime(created_at) < datetime('now', '-' || keep_days || ' days'))" +
					'))'
			)
			.run();
		stats.pin_revisions_pruned = result.meta.changes ?? 0;
	} catch (e) {
		console.warn(`gc: pin revision prune failed: ${e}`);
	}
}

/**
 * Advisory closure-completeness monitor (the cachix invariant, adapted to
 * the redirect design): count live objects with a Reference that is neither
 * resolved locally nor known to any upstream. These closures would fail to
 * substitute; the count surfaces in GC stats and the log, it does not block
 * serving.
 */
async function closureIntegrityReport(db: D1, stats: GcStats): Promise<void> {
	try {
		const row = await db
			.prepare(
				'SELECT COUNT(DISTINCT r.object_id) AS n FROM object_ref r ' +
					'JOIN object o ON o.id = r.object_id ' +
					'WHERE r.child_id IS NULL AND o.detached_at IS NULL ' +
					'AND NOT EXISTS (SELECT 1 FROM upstream_check uc ' +
					'WHERE uc.store_path_hash = r.ref_hash AND uc.present <> 0)'
			)
			.first<{ n: number }>();
		stats.incomplete_closure_objects = row?.n ?? 0;
		if (stats.incomplete_closure_objects > 0) {
			console.warn(
				`gc: ${stats.incomplete_closure_objects} objects have references neither local nor upstream-covered`
			);
		}
	} catch (e) {
		console.warn(`gc: closure integrity report failed: ${e}`);
	}
}

/** Hard-reap caches soft-deleted longer than the grace period ago. */
async function reapAbandonedCaches(db: D1, stats: GcStats): Promise<void> {
	const cutoff = new Date(Date.now() - ABANDONED_CACHE_GRACE_SECS * 1000).toISOString();
	try {
		const doomed = 'SELECT id FROM cache WHERE deleted_at IS NOT NULL AND deleted_at < ?1';
		const results = await db.batch(
			[
				`DELETE FROM object_ref WHERE object_id IN (SELECT id FROM object WHERE cache_id IN (${doomed}))`,
				`DELETE FROM gc_root WHERE cache_id IN (${doomed})`,
				`DELETE FROM pin WHERE cache_id IN (${doomed})`,
				`DELETE FROM cache_upstream WHERE cache_id IN (${doomed})`,
				`DELETE FROM object WHERE cache_id IN (${doomed})`,
				'DELETE FROM cache WHERE deleted_at IS NOT NULL AND deleted_at < ?1'
			].map((sql) => db.prepare(sql).bind(cutoff))
		);
		stats.abandoned_caches_reaped = results[results.length - 1]?.meta.changes ?? 0;
	} catch (e) {
		console.warn(`gc: abandoned cache reap failed: ${e}`);
	}
}

/**
 * Delete NARs with no objects (1h grace), then chunks with no chunkrefs
 * (R2 + D1). Held rows (holders_count > 0) are skipped — an in-flight dedup
 * has claimed them — and holds older than a day are treated as leaked by a
 * crashed request and recovered first (a real request lives minutes at most).
 */
async function reapOrphans(env: Env, stats: GcStats): Promise<void> {
	const db = env.ATTIC_DB;
	try {
		const orphanNar =
			'NOT EXISTS (SELECT 1 FROM object o WHERE o.nar_id = nar.id) ' +
			"AND datetime(nar.created_at) < datetime('now', '-1 hours')";
		const results = await db.batch([
			db.prepare(
				'UPDATE nar SET holders_count = 0, held_at = NULL WHERE holders_count > 0 ' +
					"AND (held_at IS NULL OR datetime(held_at) < datetime('now', '-1 day')) " +
					`AND ${orphanNar}`
			),
			db.prepare(
				'DELETE FROM chunkref WHERE nar_id IN ' +
					`(SELECT nar.id FROM nar WHERE nar.holders_count = 0 AND ${orphanNar})`
			),
			db.prepare(`DELETE FROM nar WHERE holders_count = 0 AND ${orphanNar}`)
		]);
		stats.orphan_nars_reaped = results[results.length - 1]?.meta.changes ?? 0;
	} catch (e) {
		console.warn(`gc: orphan NAR reap failed: ${e}`);
	}

	let orphans: { id: number; remote_file: string }[];
	try {
		await db
			.prepare(
				'UPDATE chunk SET holders_count = 0, held_at = NULL WHERE holders_count > 0 ' +
					"AND (held_at IS NULL OR datetime(held_at) < datetime('now', '-1 day')) " +
					'AND NOT EXISTS (SELECT 1 FROM chunkref cr WHERE cr.chunk_id = chunk.id)'
			)
			.run();
		orphans = (
			await db
				.prepare(
					// The grace period protects chunks of in-flight CDC uploads, whose
					// chunkref rows only land once the whole NAR is finalized.
					'SELECT id, remote_file FROM chunk ' +
						'WHERE holders_count = 0 ' +
						'AND NOT EXISTS (SELECT 1 FROM chunkref cr WHERE cr.chunk_id = chunk.id) ' +
						"AND datetime(created_at) < datetime('now', '-1 hours')"
				)
				.all<{ id: number; remote_file: string }>()
		).results;
	} catch (e) {
		console.warn(`gc: find orphan chunks failed: ${e}`);
		return;
	}

	// Bulk-delete: R2 accepts up to 1000 keys per call and D1 an IN-list, so
	// the subrequest count stays flat. The per-chunk loop this replaces spent
	// two subrequests per chunk and exhausted the invocation's ~1000-call
	// budget after ~500 orphans, silently stalling on large backlogs.
	for (let i = 0; i < orphans.length; i += R2_DELETE_BATCH) {
		const batch = orphans.slice(i, i + R2_DELETE_BATCH);
		const keys = batch.map(chunkKey).filter((k): k is string => k !== null);
		try {
			if (keys.length > 0) await env.CACHE_BUCKET.delete(keys);
		} catch (e) {
			// Keep the D1 rows so the next run retries the R2 delete.
			console.warn(`gc: failed to delete ${keys.length} R2 chunk objects: ${e}`);
			continue;
		}
		for (let j = 0; j < batch.length; j += PARAM_BATCH) {
			const ids = batch.slice(j, j + PARAM_BATCH).map((c) => c.id);
			const placeholders = ids.map((_, k) => `?${k + 1}`).join(', ');
			try {
				await db
					.prepare(`DELETE FROM chunk WHERE id IN (${placeholders})`)
					.bind(...ids)
					.run();
				stats.orphan_chunks_reaped += ids.length;
			} catch (e) {
				console.warn(`gc: failed to delete ${ids.length} chunk rows: ${e}`);
			}
		}
	}
}

/** Bound the upstream_check cache: recheck absents daily, presents eventually.
 * Rows whose registry entry was deleted go immediately. */
async function pruneUpstreamChecks(db: D1): Promise<void> {
	const absentCutoff = new Date(Date.now() - UPSTREAM_ABSENT_TTL_SECS * 1000).toISOString();
	const presentCutoff = new Date(Date.now() - UPSTREAM_PRESENT_TTL_SECS * 1000).toISOString();
	await db
		.batch([
			db
				.prepare(
					// present <> 0 covers both PRESENT and UNPERSISTABLE verdicts.
					'DELETE FROM upstream_check WHERE (present = 0 AND checked_at < ?1) OR (present <> 0 AND checked_at < ?2)'
				)
				.bind(absentCutoff, presentCutoff),
			db.prepare('DELETE FROM upstream_check WHERE upstream_id NOT IN (SELECT id FROM upstream)')
		])
		.catch((e) => console.warn(`gc: upstream_check prune failed: ${e}`));
}
