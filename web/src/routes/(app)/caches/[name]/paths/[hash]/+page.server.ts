import { error } from '@sveltejs/kit';
import { PARAM_BATCH, readSession, STORE_PATH_HASH_RE, findCache } from '$lib/server/cache/db';
import { syncObjectRefs } from '$lib/server/cache/gc';
import { canBrowseCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import type { PageServerLoad } from './$types';

interface ObjectNarRow {
	id: number;
	nar_id: number;
	store_path: string;
	refs: string;
	sigs: string;
	ca: string | null;
	deriver: string | null;
	system: string | null;
	created_at: string;
	last_accessed_at: string | null;
	created_by: string | null;
	source: string | null;
	detached_at: string | null;
	nar_hash: string;
	nar_size: number;
	nar_compression: string;
	num_chunks: number;
	nar_state: string;
}

interface ChunkListRow {
	seq: number;
	chunk_hash: string;
	chunk_size: number | null;
	file_size: number | null;
	compression: string;
	shared_nars: number;
}

interface PinRow {
	pin_id: number | null;
	note: string | null;
	created_at: string;
	pin_name: string | null;
}

interface RefRow {
	ref_hash: string;
	store_path: string | null;
	created_at: string | null;
	nar_size: number | null;
}

interface ReferrerRow {
	store_path_hash: string;
	store_path: string;
	created_at: string;
	nar_size: number;
}

/** Parse a JSON string-array column; malformed data degrades to []. */
function jsonStrings(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

// High enough that client-side pagination sees the real set for all but the
// most-depended-on paths; the windowed total still reports any truncation.
const REFERRERS_LIMIT = 500;

export const load: PageServerLoad = async ({ platform, params, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	if (!STORE_PATH_HASH_RE.test(params.hash)) {
		throw error(404, 'Store path not found');
	}
	const read = readSession(db);

	const [cache, access] = await Promise.all([
		findCache(read, params.name),
		effectiveAccessOf(locals, db)
	]);

	if (!cache) throw error(404, `Cache "${params.name}" not found`);
	// Same browse rule as the /paths explorer: public caches are viewable by
	// any active user; private ones need a grant.
	if (!canBrowseCache(access, { name: cache.name, isPublic: cache.is_public === 1 })) {
		throw error(403, 'Permission denied');
	}

	// References/referrers read object_ref, which is derived from object.refs
	// by a watermark-incremental sync that otherwise only runs on the nightly
	// GC — a path pushed since the last run would render empty. Sync inline
	// (same pattern as detachClosure); when caught up this is one row read.
	// The two object_ref queries below then read the primary, not the replica
	// session, so they see what the sync just wrote.
	await syncObjectRefs(db);

	// Everything below keys off (cache_id, store_path_hash); nar_id / object_id
	// are resolved by scalar subqueries so all reads run in parallel.
	const [object, chunks, pins, refs, referrers] = await Promise.all([
		read
			.prepare(
				`SELECT o.id, o.nar_id, o.store_path, o.refs, o.sigs, o.ca, o.deriver, o.system,
				        o.created_at, o.last_accessed_at, o.created_by, o.source, o.detached_at,
				        n.nar_hash, n.nar_size, n.compression AS nar_compression,
				        n.num_chunks, n.state AS nar_state
				 FROM object o
				 JOIN nar n ON n.id = o.nar_id
				 WHERE o.cache_id = ?1 AND o.store_path_hash = ?2`
			)
			.bind(cache.id, params.hash)
			.first<ObjectNarRow>(),
		// Chunks in NAR order, each with how many OTHER NARs share it (dedup
		// indicator). One grouped join, not a per-chunk count.
		read
			.prepare(
				`SELECT cr.seq, cr.chunk_hash, ch.chunk_size, ch.file_size, cr.compression,
				        COUNT(DISTINCT cr2.nar_id) AS shared_nars
				 FROM chunkref cr
				 LEFT JOIN chunk ch ON ch.id = cr.chunk_id
				 LEFT JOIN chunkref cr2 ON cr2.chunk_id = cr.chunk_id AND cr2.nar_id != cr.nar_id
				 WHERE cr.nar_id = (SELECT nar_id FROM object
				                    WHERE cache_id = ?1 AND store_path_hash = ?2)
				 GROUP BY cr.id
				 ORDER BY cr.seq`
			)
			.bind(cache.id, params.hash)
			.all<ChunkListRow>(),
		// Anonymous pin (pin_id NULL) and/or named-pin revisions.
		read
			.prepare(
				`SELECT g.pin_id, g.note, g.created_at, p.name AS pin_name
				 FROM gc_root g
				 LEFT JOIN pin p ON p.id = g.pin_id
				 WHERE g.cache_id = ?1 AND g.store_path_hash = ?2
				 ORDER BY g.created_at DESC`
			)
			.bind(cache.id, params.hash)
			.all<PinRow>(),
		// References, resolved to a store path when the referenced object exists
		// in this cache (via child_id when linked, else by hash), each carrying
		// its added date and NAR size through the object → nar join. Unresolved
		// hashes keep NULL columns and render as bare hashes.
		db
			.prepare(
				`SELECT r.ref_hash,
				        COALESCE(oc.store_path, oh.store_path) AS store_path,
				        COALESCE(oc.created_at, oh.created_at) AS created_at,
				        COALESCE(nc.nar_size, nh.nar_size) AS nar_size
				 FROM object_ref r
				 LEFT JOIN object oc ON oc.id = r.child_id AND oc.cache_id = ?1
				 LEFT JOIN nar nc ON nc.id = oc.nar_id
				 LEFT JOIN object oh ON oh.cache_id = ?1 AND oh.store_path_hash = r.ref_hash
				 LEFT JOIN nar nh ON nh.id = oh.nar_id
				 WHERE r.object_id = (SELECT id FROM object
				                      WHERE cache_id = ?1 AND store_path_hash = ?2)
				 ORDER BY COALESCE(oc.store_path, oh.store_path, r.ref_hash)`
			)
			.bind(cache.id, params.hash)
			.all<RefRow>(),
		// Reverse dependencies: objects in this cache that reference this hash.
		// total rides on the rows as a window aggregate (computed before LIMIT),
		// so the "and N more" count costs no second scan of the join.
		db
			.prepare(
				`SELECT o.store_path_hash, o.store_path, o.created_at, n.nar_size,
				        COUNT(*) OVER () AS total
				 FROM object_ref r
				 JOIN object o ON o.id = r.object_id
				 JOIN nar n ON n.id = o.nar_id
				 WHERE r.ref_hash = ?2 AND o.cache_id = ?1
				 ORDER BY o.store_path ASC
				 LIMIT ${REFERRERS_LIMIT}`
			)
			.bind(cache.id, params.hash)
			.all<ReferrerRow & { total: number }>()
	]);

	if (!object) throw error(404, 'Store path not found in this cache');

	// References with no object in this cache usually exist somewhere else:
	// pushes skip paths an upstream already serves (get-missing-paths filters
	// on cached verdicts), and closures can span caches. Resolve the gaps from
	// data already on hand — other browsable caches first (linkable, with real
	// metadata), then cached upstream verdicts — never by probing upstreams.
	type Elsewhere =
		| { kind: 'cache'; cache: string; storePath: string; createdAt: string; narSize: number }
		| { kind: 'upstream'; host: string };
	const elsewhere = new Map<string, Elsewhere>();
	const unresolved = refs.results.filter((r) => !r.store_path).map((r) => r.ref_hash);
	for (let i = 0; i < unresolved.length; i += PARAM_BATCH) {
		const batch = unresolved.slice(i, i + PARAM_BATCH);
		const marks = batch.map(() => '?').join(', ');
		const [inCaches, inUpstreams] = await Promise.all([
			read
				.prepare(
					`SELECT o.store_path_hash AS hash, o.store_path, o.created_at, n.nar_size,
					        c.name AS cache_name, c.is_public
					 FROM object o
					 JOIN cache c ON c.id = o.cache_id
					 JOIN nar n ON n.id = o.nar_id
					 WHERE o.store_path_hash IN (${marks}) AND o.cache_id != ?
					   AND c.deleted_at IS NULL
					 ORDER BY c.priority ASC, c.name ASC`
				)
				.bind(...batch, cache.id)
				.all<{
					hash: string;
					store_path: string;
					created_at: string;
					nar_size: number;
					cache_name: string;
					is_public: number;
				}>(),
			read
				.prepare(
					`SELECT uc.store_path_hash AS hash, u.url
					 FROM upstream_check uc
					 JOIN upstream u ON u.id = uc.upstream_id
					 WHERE uc.present = 1 AND uc.store_path_hash IN (${marks})
					 ORDER BY u.position ASC`
				)
				.bind(...batch)
				.all<{ hash: string; url: string }>()
		]);
		for (const row of inCaches.results) {
			if (elsewhere.has(row.hash)) continue;
			if (!canBrowseCache(access, { name: row.cache_name, isPublic: row.is_public === 1 })) {
				continue;
			}
			elsewhere.set(row.hash, {
				kind: 'cache',
				cache: row.cache_name,
				storePath: row.store_path,
				createdAt: row.created_at,
				narSize: row.nar_size
			});
		}
		for (const row of inUpstreams.results) {
			if (!elsewhere.has(row.hash)) {
				elsewhere.set(row.hash, { kind: 'upstream', host: new URL(row.url).host });
			}
		}
	}

	return {
		cache: { name: cache.name },
		object: {
			hash: params.hash,
			storePath: object.store_path,
			refs: jsonStrings(object.refs),
			sigs: jsonStrings(object.sigs),
			ca: object.ca,
			deriver: object.deriver,
			system: object.system,
			createdAt: object.created_at,
			lastAccessedAt: object.last_accessed_at,
			createdBy: object.created_by,
			source: object.source,
			detachedAt: object.detached_at
		},
		nar: {
			narHash: object.nar_hash,
			narSize: object.nar_size,
			compression: object.nar_compression,
			numChunks: object.num_chunks,
			state: object.nar_state
		},
		chunks: chunks.results.map((c) => ({
			seq: c.seq,
			chunkHash: c.chunk_hash,
			chunkSize: c.chunk_size,
			fileSize: c.file_size,
			compression: c.compression,
			sharedNars: c.shared_nars
		})),
		pins: {
			anonymous: (() => {
				const anon = pins.results.find((p) => p.pin_id === null);
				return anon ? { note: anon.note, createdAt: anon.created_at } : null;
			})(),
			named: pins.results
				.filter((p) => p.pin_id !== null)
				.map((p) => ({ name: p.pin_name ?? `#${p.pin_id}`, note: p.note, createdAt: p.created_at }))
		},
		references: refs.results.map((r) => ({
			hash: r.ref_hash,
			storePath: r.store_path,
			createdAt: r.created_at,
			narSize: r.nar_size,
			elsewhere: r.store_path ? null : (elsewhere.get(r.ref_hash) ?? null)
		})),
		referrers: {
			rows: referrers.results.map((r) => ({
				hash: r.store_path_hash,
				storePath: r.store_path,
				createdAt: r.created_at,
				narSize: r.nar_size
			})),
			total: referrers.results[0]?.total ?? 0
		}
	};
};
