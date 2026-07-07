// Garbage collection, ported from the Rust worker's gc.rs and extended with
// closure-aware retention: an object survives if it is reachable from a fresh
// object or a gc_root, and per-cache size budgets evict least-recently-used
// closures (never individual paths out of a kept closure).
//
// Runs from the scheduled (cron) handler and the manual /_api/v1/gc trigger.
// Every sweep is idempotent; passes are ordered so each exposes work for the
// next (retention deletes objects -> orphans NARs -> orphans chunks -> R2).

import { chunkKey } from './db';
import { narinfoTag, type ExecutionContext } from './store';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];

const ABANDONED_UPLOAD_MAX_AGE_SECS = 24 * 60 * 60;
const ABANDONED_CACHE_GRACE_SECS = 7 * 24 * 60 * 60;
/** Upstream "absent" verdicts are rechecked after this long; "present" is stable. */
const UPSTREAM_ABSENT_TTL_SECS = 24 * 60 * 60;
const UPSTREAM_PRESENT_TTL_SECS = 90 * 24 * 60 * 60;
const REF_SYNC_BATCH = 500;
const DELETE_BATCH = 99;
const PURGE_TAG_BATCH = 100;
const R2_DELETE_BATCH = 1000;

export interface GcStats {
	abandoned_uploads_reaped: number;
	abandoned_upload_errors: number;
	abandoned_caches_reaped: number;
	expired_objects_reaped: number;
	size_evicted_objects: number;
	global_evicted_objects: number;
	orphan_nars_reaped: number;
	orphan_chunks_reaped: number;
	refs_synced: number;
	narinfo_tags_purged: number;
	[key: string]: number;
}

function emptyStats(): GcStats {
	return {
		abandoned_uploads_reaped: 0,
		abandoned_upload_errors: 0,
		abandoned_caches_reaped: 0,
		expired_objects_reaped: 0,
		size_evicted_objects: 0,
		global_evicted_objects: 0,
		orphan_nars_reaped: 0,
		orphan_chunks_reaped: 0,
		refs_synced: 0,
		narinfo_tags_purged: 0
	};
}

export async function runGc(
	env: Env,
	opts: { dryRun?: boolean; ctx?: ExecutionContext } = {}
): Promise<GcStats> {
	const stats = emptyStats();
	const dryRun = opts.dryRun ?? false;
	// Cache-Tags of deleted objects, purged from the edge cache at the end so
	// long-TTL narinfo entries stop being served once their storage is gone.
	const purgeTags: string[] = [];

	await syncObjectRefs(env.ATTIC_DB, stats);

	if (!dryRun) {
		await reapAbandonedUploads(env, stats);
		await reapAbandonedCaches(env.ATTIC_DB, stats);
	}
	await retentionPass(env.ATTIC_DB, stats, dryRun, purgeTags);
	await globalSizePass(env.ATTIC_DB, stats, dryRun, purgeTags);
	if (!dryRun) {
		await reapOrphans(env, stats);
		await env.ATTIC_DB.prepare('DELETE FROM device_auth WHERE expires_at < ?1')
			.bind(Math.floor(Date.now() / 1000))
			.run()
			.catch((e) => console.warn(`gc: device_auth cleanup failed: ${e}`));
		await pruneUpstreamChecks(env.ATTIC_DB);
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
	if (tags.length === 0) return;
	const store = ctx?.exports?.CachedStore;
	if (!store) {
		console.warn(`gc: CachedStore unavailable; skipping purge of ${tags.length} narinfo tags`);
		return;
	}
	// Batches run sequentially on purpose: purge shares the zone purge API's
	// rate limits, and GC latency is off any request path.
	for (let i = 0; i < tags.length; i += PURGE_TAG_BATCH) {
		const batch = tags.slice(i, i + PURGE_TAG_BATCH);
		try {
			await store.purgeTags(batch);
			stats.narinfo_tags_purged += batch.length;
		} catch (e) {
			console.warn(`gc: narinfo tag purge failed (${batch.length} tags): ${e}`);
		}
	}
}

/**
 * Derive object_ref rows from object.refs JSON, in id windows so a single
 * statement never writes an unbounded number of rows. Also serves as the
 * initial backfill; the watermark makes reruns cheap.
 */
async function syncObjectRefs(db: D1, stats: GcStats): Promise<void> {
	const bounds = await db
		.prepare(
			'SELECT COALESCE((SELECT MAX(object_id) FROM object_ref), 0) AS watermark, ' +
				'COALESCE((SELECT MAX(id) FROM object), 0) AS max_id'
		)
		.first<{ watermark: number; max_id: number }>();
	if (!bounds) return;

	for (let start = bounds.watermark; start < bounds.max_id; start += REF_SYNC_BATCH) {
		const result = await db
			.prepare(
				'INSERT OR IGNORE INTO object_ref (object_id, ref_hash) ' +
					'SELECT o.id, substr(j.value, 1, 32) FROM object o, json_each(o.refs) j ' +
					'WHERE o.id > ?1 AND o.id <= ?2 ' +
					'AND length(j.value) >= 32 AND substr(j.value, 1, 32) <> o.store_path_hash'
			)
			.bind(start, start + REF_SYNC_BATCH)
			.run();
		stats.refs_synced += result.meta.changes ?? 0;
	}
}

interface ObjectRow {
	id: number;
	store_path_hash: string;
	nar_id: number;
	last_used: string;
}

/**
 * Closure-aware retention per cache. Runs only for caches with a time window
 * or size budget configured.
 *
 * Keep set = closure(gc_roots) ∪ closure(fresh objects); if the cache is over
 * its size budget, the keep set is rebuilt greedily: root closures first, then
 * top-level closures by last-access recency until the budget is exhausted.
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
			const objects = await loadObjects(db, cache.id);
			if (objects.length === 0) continue;

			const byHash = new Map(objects.map((o) => [o.store_path_hash, o]));
			const children = await loadRefEdges(db, cache.id, byHash);

			const rootHashes = (
				await db
					.prepare('SELECT store_path_hash FROM gc_root WHERE cache_id = ?1')
					.bind(cache.id)
					.all<{ store_path_hash: string }>()
			).results.map((r) => r.store_path_hash);
			const rootIds = rootHashes
				.map((h) => byHash.get(h)?.id)
				.filter((id): id is number => id !== undefined);

			const freshCutoff =
				cache.retention_period != null
					? Date.now() - cache.retention_period * 24 * 60 * 60 * 1000
					: null;
			const isFresh = (o: ObjectRow) =>
				freshCutoff === null || Date.parse(o.last_used) >= freshCutoff;

			const freshIds = objects.filter(isFresh).map((o) => o.id);
			let keep = closure(new Set([...rootIds, ...freshIds]), children);

			let sizeEvicted = 0;
			if (cache.retention_max_bytes != null) {
				const narSizes = await loadNarSizes(db, cache.id);
				const { kept, evicted } = trimToBudget(
					objects,
					children,
					keep,
					new Set(rootIds),
					narSizes,
					cache.retention_max_bytes
				);
				sizeEvicted = evicted;
				keep = kept;
			}

			const doomed = objects.filter((o) => !keep.has(o.id));
			if (!dryRun) {
				await deleteObjects(
					db,
					doomed.map((o) => o.id)
				);
				purgeTags.push(...doomed.map((o) => narinfoTag(cache.name, o.store_path_hash)));
			}
			stats.size_evicted_objects += sizeEvicted;
			stats.expired_objects_reaped += doomed.length - sizeEvicted;
		} catch (e) {
			console.warn(`gc: retention pass failed for cache ${cache.name}: ${e}`);
		}
	}
}

async function loadObjects(db: D1, cacheId: number): Promise<ObjectRow[]> {
	const rows: ObjectRow[] = [];
	let lastId = 0;
	for (;;) {
		const page = (
			await db
				.prepare(
					'SELECT id, store_path_hash, nar_id, COALESCE(last_accessed_at, created_at) AS last_used ' +
						'FROM object WHERE cache_id = ?1 AND id > ?2 ORDER BY id LIMIT 5000'
				)
				.bind(cacheId, lastId)
				.all<ObjectRow>()
		).results;
		rows.push(...page);
		if (page.length < 5000) return rows;
		lastId = page[page.length - 1].id;
	}
}

/** object_id -> ids of the objects it directly references (within the cache). */
async function loadRefEdges(
	db: D1,
	cacheId: number,
	byHash: Map<string, ObjectRow>
): Promise<Map<number, number[]>> {
	const children = new Map<number, number[]>();
	let lastId = 0;
	for (;;) {
		const page = (
			await db
				.prepare(
					'SELECT r.object_id, r.ref_hash FROM object_ref r ' +
						'JOIN object o ON o.id = r.object_id ' +
						'WHERE o.cache_id = ?1 AND r.object_id > ?2 ' +
						'ORDER BY r.object_id LIMIT 10000'
				)
				.bind(cacheId, lastId)
				.all<{ object_id: number; ref_hash: string }>()
		).results;
		for (const edge of page) {
			const target = byHash.get(edge.ref_hash);
			if (!target) continue;
			let list = children.get(edge.object_id);
			if (!list) children.set(edge.object_id, (list = []));
			list.push(target.id);
		}
		if (page.length < 10000) return children;
		lastId = page[page.length - 1].object_id;
	}
}

async function loadNarSizes(db: D1, cacheId: number): Promise<Map<number, number>> {
	const rows = (
		await db
			.prepare(
				'SELECT cr.nar_id AS nar_id, COALESCE(SUM(ch.file_size), 0) AS bytes ' +
					'FROM chunkref cr JOIN chunk ch ON ch.id = cr.chunk_id ' +
					'WHERE cr.nar_id IN (SELECT DISTINCT nar_id FROM object WHERE cache_id = ?1) ' +
					'GROUP BY cr.nar_id'
			)
			.bind(cacheId)
			.all<{ nar_id: number; bytes: number }>()
	).results;
	return new Map(rows.map((r) => [r.nar_id, r.bytes]));
}

function closure(seeds: Set<number>, children: Map<number, number[]>): Set<number> {
	const seen = new Set(seeds);
	const stack = [...seeds];
	while (stack.length > 0) {
		const id = stack.pop()!;
		for (const child of children.get(id) ?? []) {
			if (!seen.has(child)) {
				seen.add(child);
				stack.push(child);
			}
		}
	}
	return seen;
}

/**
 * Greedy LRU-by-closure eviction. Root closures are always kept (even over
 * budget); then top-level keep candidates (not referenced by any other keep
 * candidate) are added closure-by-closure, most recently used first, while the
 * deduplicated NAR byte total stays within budget.
 */
function trimToBudget(
	objects: ObjectRow[],
	children: Map<number, number[]>,
	keepCandidates: Set<number>,
	rootIds: Set<number>,
	narSizes: Map<number, number>,
	budget: number
): { kept: Set<number>; evicted: number } {
	const byId = new Map(objects.map((o) => [o.id, o]));

	const kept = closure(rootIds, children);
	const keptNars = new Set<number>();
	let total = 0;
	const addBytes = (ids: Iterable<number>) => {
		for (const id of ids) {
			const narId = byId.get(id)?.nar_id;
			if (narId !== undefined && !keptNars.has(narId)) {
				keptNars.add(narId);
				total += narSizes.get(narId) ?? 0;
			}
		}
	};
	addBytes(kept);
	if (total > budget) {
		console.warn(`gc: gc_root closures alone exceed size budget (${total} > ${budget})`);
	}

	// Top-levels: keep candidates that no other keep candidate references.
	const referenced = new Set<number>();
	for (const id of keepCandidates) {
		for (const child of children.get(id) ?? []) {
			if (child !== id && keepCandidates.has(child)) referenced.add(child);
		}
	}
	const topLevels = [...keepCandidates]
		.filter((id) => !referenced.has(id) && !kept.has(id))
		.map((id) => byId.get(id)!)
		.sort((a, b) => Date.parse(b.last_used) - Date.parse(a.last_used));

	for (const top of topLevels) {
		const closureIds = closure(new Set([top.id]), children);
		let added = 0;
		const newNars = new Set<number>();
		for (const id of closureIds) {
			if (kept.has(id)) continue;
			const narId = byId.get(id)?.nar_id;
			if (narId !== undefined && !keptNars.has(narId) && !newNars.has(narId)) {
				newNars.add(narId);
				added += narSizes.get(narId) ?? 0;
			}
		}
		if (total + added > budget) continue;
		total += added;
		for (const id of closureIds) kept.add(id);
		for (const narId of newNars) keptNars.add(narId);
	}

	const evicted = [...keepCandidates].filter((id) => !kept.has(id)).length;
	return { kept, evicted };
}

async function deleteObjects(db: D1, ids: number[]): Promise<void> {
	for (let i = 0; i < ids.length; i += DELETE_BATCH) {
		const batch = ids.slice(i, i + DELETE_BATCH);
		const placeholders = batch.map((_, j) => `?${j + 1}`).join(', ');
		await db
			.prepare(`DELETE FROM object_ref WHERE object_id IN (${placeholders})`)
			.bind(...batch)
			.run();
		await db
			.prepare(`DELETE FROM object WHERE id IN (${placeholders})`)
			.bind(...batch)
			.run();
	}
}

/**
 * Global physical-storage ceiling (server_config.global_max_bytes): when total
 * deduplicated chunk bytes exceed the limit, evict least-recently-used
 * top-level closures across ALL caches until under it. A NAR's bytes only
 * count as freed when the last object referencing it (in any cache) is gone,
 * so paths shared with another cache never free storage — and are deprioritized
 * implicitly because evicting them gains nothing. gc_root closures are exempt.
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
	let total = totalRow?.n ?? 0;
	if (total <= limit) return;

	const caches = (
		await db
			.prepare('SELECT id, name FROM cache WHERE deleted_at IS NULL')
			.all<{ id: number; name: string }>()
	).results;
	const narSizes = await loadAllNarSizes(db);
	const rootRows = (
		await db.prepare('SELECT cache_id, store_path_hash FROM gc_root').all<{
			cache_id: number;
			store_path_hash: string;
		}>()
	).results;

	// Objects still referencing each NAR, across all caches.
	const narRefs = new Map<number, number>();
	interface CacheGraph {
		cacheName: string;
		surviving: Set<number>;
		byId: Map<number, ObjectRow>;
		children: Map<number, number[]>;
		protectedIds: Set<number>;
	}
	const graphs = new Map<number, CacheGraph>();

	for (const cache of caches) {
		const objects = await loadObjects(db, cache.id);
		const byHash = new Map(objects.map((o) => [o.store_path_hash, o]));
		const children = await loadRefEdges(db, cache.id, byHash);
		const rootIds = rootRows
			.filter((r) => r.cache_id === cache.id)
			.map((r) => byHash.get(r.store_path_hash)?.id)
			.filter((id): id is number => id !== undefined);
		graphs.set(cache.id, {
			cacheName: cache.name,
			surviving: new Set(objects.map((o) => o.id)),
			byId: new Map(objects.map((o) => [o.id, o])),
			children,
			protectedIds: closure(new Set(rootIds), children)
		});
		for (const o of objects) narRefs.set(o.nar_id, (narRefs.get(o.nar_id) ?? 0) + 1);
	}

	const doomed: { id: number; tag: string }[] = [];
	const MAX_EVICTIONS = 500;

	for (let round = 0; total > limit && round < MAX_EVICTIONS; round++) {
		// Oldest unprotected top-level (no surviving in-cache referrer) wins eviction.
		let oldest: { graph: CacheGraph; id: number; lastUsed: number } | null = null;
		for (const graph of graphs.values()) {
			const referenced = new Set<number>();
			for (const id of graph.surviving) {
				for (const child of graph.children.get(id) ?? []) {
					if (child !== id && graph.surviving.has(child)) referenced.add(child);
				}
			}
			for (const id of graph.surviving) {
				if (referenced.has(id) || graph.protectedIds.has(id)) continue;
				const lastUsed = Date.parse(graph.byId.get(id)!.last_used);
				if (!oldest || lastUsed < oldest.lastUsed) oldest = { graph, id, lastUsed };
			}
		}
		if (!oldest) break;

		// Delete the closure members nothing else in the cache still needs.
		const { graph } = oldest;
		const targetClosure = closure(new Set([oldest.id]), graph.children);
		const seeds = new Set(graph.protectedIds);
		for (const id of graph.surviving) if (!targetClosure.has(id)) seeds.add(id);
		const kept = closure(seeds, graph.children);

		for (const id of targetClosure) {
			if (kept.has(id)) continue;
			graph.surviving.delete(id);
			const obj = graph.byId.get(id)!;
			doomed.push({ id, tag: narinfoTag(graph.cacheName, obj.store_path_hash) });
			const remaining = (narRefs.get(obj.nar_id) ?? 1) - 1;
			narRefs.set(obj.nar_id, remaining);
			if (remaining === 0) total -= narSizes.get(obj.nar_id) ?? 0;
		}
	}

	if (!dryRun) {
		await deleteObjects(
			db,
			doomed.map((d) => d.id)
		);
		purgeTags.push(...doomed.map((d) => d.tag));
	}
	stats.global_evicted_objects += doomed.length;
	if (total > limit) {
		console.warn(`gc: still over global limit after eviction pass (${total} > ${limit})`);
	}
}

async function loadAllNarSizes(db: D1): Promise<Map<number, number>> {
	const rows = (
		await db
			.prepare(
				'SELECT cr.nar_id AS nar_id, COALESCE(SUM(ch.file_size), 0) AS bytes ' +
					'FROM chunkref cr JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id'
			)
			.all<{ nar_id: number; bytes: number }>()
	).results;
	return new Map(rows.map((r) => [r.nar_id, r.bytes]));
}

// Best-effort per-isolate debounce for upload-triggered size checks.
let lastSizeCheck = 0;
const SIZE_CHECK_DEBOUNCE_MS = 60_000;

/**
 * Run GC immediately if any size budget (per-cache or global) is exceeded.
 * Hooked into upload traffic via ctx.waitUntil, debounced per isolate so a
 * large push doesn't re-check on every request.
 */
export async function maybeSizeTriggeredGc(env: Env, ctx?: ExecutionContext): Promise<void> {
	const now = Date.now();
	if (now - lastSizeCheck < SIZE_CHECK_DEBOUNCE_MS) return;
	lastSizeCheck = now;
	try {
		if (await anyBudgetExceeded(env.ATTIC_DB)) {
			console.log('gc: size budget exceeded, running out-of-band');
			const stats = await runGc(env, { ctx });
			console.log(`gc (size-triggered): ${JSON.stringify(stats)}`);
		}
	} catch (e) {
		console.warn(`gc: size-trigger check failed: ${e}`);
	}
}

async function anyBudgetExceeded(db: D1): Promise<boolean> {
	const limitRow = await db
		.prepare("SELECT value FROM server_config WHERE key = 'global_max_bytes'")
		.first<{ value: string }>();
	const globalLimit = limitRow ? Number(limitRow.value) : NaN;
	if (Number.isFinite(globalLimit) && globalLimit > 0) {
		const total = await db
			.prepare("SELECT COALESCE(SUM(file_size), 0) AS n FROM chunk WHERE state = 'V'")
			.first<{ n: number }>();
		if ((total?.n ?? 0) > globalLimit) return true;
	}

	const caches = (
		await db
			.prepare(
				'SELECT id, retention_max_bytes FROM cache ' +
					'WHERE deleted_at IS NULL AND retention_max_bytes IS NOT NULL'
			)
			.all<{ id: number; retention_max_bytes: number }>()
	).results;
	for (const cache of caches) {
		const size = await db
			.prepare(
				'SELECT COALESCE(SUM(sz.bytes), 0) AS n FROM object o ' +
					'JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr ' +
					'JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz ON sz.nar_id = o.nar_id ' +
					'WHERE o.cache_id = ?1'
			)
			.bind(cache.id)
			.first<{ n: number }>();
		if ((size?.n ?? 0) > cache.retention_max_bytes) return true;
	}
	return false;
}

export interface GcRootInfo {
	hash: string;
	note: string | null;
	createdAt: string;
	/** False when no live object matches the pinned hash (pin has no effect). */
	inCache: boolean;
	closureObjects: number;
	closureBytes: number;
}

/** GC roots for a cache, each with the size of the closure it protects. */
export async function listGcRoots(env: Env, cacheId: number): Promise<GcRootInfo[]> {
	const db = env.ATTIC_DB;
	const roots = (
		await db
			.prepare(
				'SELECT store_path_hash, note, created_at FROM gc_root WHERE cache_id = ?1 ORDER BY created_at DESC'
			)
			.bind(cacheId)
			.all<{ store_path_hash: string; note: string | null; created_at: string }>()
	).results;
	if (roots.length === 0) return [];

	const objects = await loadObjects(db, cacheId);
	const byHash = new Map(objects.map((o) => [o.store_path_hash, o]));
	const byId = new Map(objects.map((o) => [o.id, o]));
	const children = await loadRefEdges(db, cacheId, byHash);
	const narSizes = await loadNarSizes(db, cacheId);

	return roots.map((root) => {
		const target = byHash.get(root.store_path_hash);
		if (!target) {
			return {
				hash: root.store_path_hash,
				note: root.note,
				createdAt: root.created_at,
				inCache: false,
				closureObjects: 0,
				closureBytes: 0
			};
		}
		const ids = closure(new Set([target.id]), children);
		const nars = new Set([...ids].map((id) => byId.get(id)!.nar_id));
		let bytes = 0;
		for (const narId of nars) bytes += narSizes.get(narId) ?? 0;
		return {
			hash: root.store_path_hash,
			note: root.note,
			createdAt: root.created_at,
			inCache: true,
			closureObjects: ids.size,
			closureBytes: bytes
		};
	});
}

/**
 * Delete a store path's closure, minus anything still reachable from paths
 * outside that closure or from gc_roots. Pruning a pinned path is a no-op
 * (unpin first). Freed NARs/chunks are reclaimed by the next GC orphan pass.
 * Returns the number of deleted objects.
 */
export async function pruneClosure(env: Env, cacheId: number, hash: string): Promise<number> {
	const db = env.ATTIC_DB;
	const objects = await loadObjects(db, cacheId);
	const byHash = new Map(objects.map((o) => [o.store_path_hash, o]));
	const target = byHash.get(hash);
	if (!target) return 0;

	const children = await loadRefEdges(db, cacheId, byHash);
	const targetClosure = closure(new Set([target.id]), children);

	const rootHashes = (
		await db
			.prepare('SELECT store_path_hash FROM gc_root WHERE cache_id = ?1')
			.bind(cacheId)
			.all<{ store_path_hash: string }>()
	).results;

	const seeds = new Set<number>();
	for (const o of objects) if (!targetClosure.has(o.id)) seeds.add(o.id);
	for (const r of rootHashes) {
		const rooted = byHash.get(r.store_path_hash);
		if (rooted) seeds.add(rooted.id);
	}

	const kept = closure(seeds, children);
	const doomed = [...targetClosure].filter((id) => !kept.has(id));
	await deleteObjects(db, doomed);
	return doomed.length;
}

/** Abort R2 multipart uploads for chunked uploads that never completed. */
async function reapAbandonedUploads(env: Env, stats: GcStats): Promise<void> {
	const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_MAX_AGE_SECS * 1000).toISOString();
	let stale: { token: string; r2_key: string; r2_upload_id: string }[];
	try {
		stale = (
			await env.ATTIC_DB.prepare(
				'SELECT token, r2_key, r2_upload_id FROM pending_upload WHERE datetime(created_at) < datetime(?1)'
			)
				.bind(cutoff)
				.all<{ token: string; r2_key: string; r2_upload_id: string }>()
		).results;
	} catch (e) {
		console.warn(`gc: failed to list stale pending uploads: ${e}`);
		return;
	}

	for (const upload of stale) {
		try {
			const multipart = env.CACHE_BUCKET.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id);
			await multipart.abort();
		} catch (e) {
			// Best-effort: the upload may already be aborted or expired.
			console.warn(`gc: failed to abort multipart ${upload.r2_key}: ${e}`);
		}
		try {
			await env.ATTIC_DB.prepare('DELETE FROM pending_upload WHERE token = ?1')
				.bind(upload.token)
				.run();
			stats.abandoned_uploads_reaped++;
		} catch (e) {
			stats.abandoned_upload_errors++;
			console.warn(`gc: failed to delete pending_upload row: ${e}`);
		}
	}
}

/** Hard-reap caches soft-deleted longer than the grace period ago. */
async function reapAbandonedCaches(db: D1, stats: GcStats): Promise<void> {
	const cutoff = new Date(Date.now() - ABANDONED_CACHE_GRACE_SECS * 1000).toISOString();
	try {
		const doomed = 'SELECT id FROM cache WHERE deleted_at IS NOT NULL AND deleted_at < ?1';
		for (const sql of [
			`DELETE FROM object_ref WHERE object_id IN (SELECT id FROM object WHERE cache_id IN (${doomed}))`,
			`DELETE FROM gc_root WHERE cache_id IN (${doomed})`,
			`DELETE FROM object WHERE cache_id IN (${doomed})`,
			`DELETE FROM pending_upload WHERE cache_id IN (${doomed})`
		]) {
			await db.prepare(sql).bind(cutoff).run();
		}
		const result = await db
			.prepare('DELETE FROM cache WHERE deleted_at IS NOT NULL AND deleted_at < ?1')
			.bind(cutoff)
			.run();
		stats.abandoned_caches_reaped = result.meta.changes ?? 0;
	} catch (e) {
		console.warn(`gc: abandoned cache reap failed: ${e}`);
	}
}

/** Delete NARs with no objects (1h grace), then chunks with no chunkrefs (R2 + D1). */
async function reapOrphans(env: Env, stats: GcStats): Promise<void> {
	const db = env.ATTIC_DB;
	try {
		await db
			.prepare(
				'DELETE FROM chunkref WHERE nar_id IN (' +
					'SELECT n.id FROM nar n WHERE NOT EXISTS (SELECT 1 FROM object o WHERE o.nar_id = n.id) ' +
					"AND datetime(n.created_at) < datetime('now', '-1 hours'))"
			)
			.run();
		const result = await db
			.prepare(
				'DELETE FROM nar WHERE NOT EXISTS (SELECT 1 FROM object o WHERE o.nar_id = nar.id) ' +
					"AND datetime(created_at) < datetime('now', '-1 hours')"
			)
			.run();
		stats.orphan_nars_reaped = result.meta.changes ?? 0;
	} catch (e) {
		console.warn(`gc: orphan NAR reap failed: ${e}`);
	}

	let orphans: { id: number; remote_file: string }[];
	try {
		orphans = (
			await db
				.prepare(
					// The grace period protects chunks of in-flight CDC uploads, whose
					// chunkref rows only land once the whole NAR is finalized.
					'SELECT id, remote_file FROM chunk ' +
						'WHERE NOT EXISTS (SELECT 1 FROM chunkref cr WHERE cr.chunk_id = chunk.id) ' +
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
		for (let j = 0; j < batch.length; j += DELETE_BATCH) {
			const ids = batch.slice(j, j + DELETE_BATCH).map((c) => c.id);
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

/** Bound the upstream_check cache: recheck absents daily, presents eventually. */
async function pruneUpstreamChecks(db: D1): Promise<void> {
	const absentCutoff = new Date(Date.now() - UPSTREAM_ABSENT_TTL_SECS * 1000).toISOString();
	const presentCutoff = new Date(Date.now() - UPSTREAM_PRESENT_TTL_SECS * 1000).toISOString();
	await db
		.prepare(
			'DELETE FROM upstream_check WHERE (present = 0 AND checked_at < ?1) OR (present = 1 AND checked_at < ?2)'
		)
		.bind(absentCutoff, presentCutoff)
		.run()
		.catch((e) => console.warn(`gc: upstream_check prune failed: ${e}`));
}
