// Read-path queries against the attic tables in D1, mirroring the Rust
// worker's d1.rs so both implementations stay drop-in compatible on the same
// database.

import { countD1, measure } from './latency';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { isActiveUser } from '../auth/types';
import { withRetry } from './platform';

/** D1 caps bound parameters per statement; IN-lists are windowed to this. */
export const PARAM_BATCH = 99;
/** Statements per db.batch() call; larger sets are split into sequential batches. */
export const STMT_BATCH = 100;

/**
 * D1 serializes writes through a single primary Durable Object; under a burst
 * (a wide `nix push` plus its get-missing-paths reads) that primary's request
 * queue can back up and reject a call with "D1 requests queued for too long" or
 * drop the connection. A failed response can follow a committed transaction,
 * so callers must make writes replay-safe and reconcile ambiguous outcomes.
 * Replica sessions (readSession) add their own
 * failure mode — "Replica disconnected from primary" — equally transient: the
 * retried query just lands on a healthy replica or the primary. Constraint/
 * logic errors carry different messages, are not matched, and surface
 * immediately.
 */
const TRANSIENT_D1_ERROR =
	/queued for too long|Network connection lost|storage (?:caused|operation)|reset because|connection (?:lost|reset)|please try again|replica disconnected/i;

export function isTransientD1Error(e: unknown): boolean {
	return TRANSIENT_D1_ERROR.test(e instanceof Error ? e.message : String(e));
}

/** Retry a D1 operation on transient primary-queue/connection errors with
 * jittered exponential backoff (~40/80/160 ms). Non-transient errors rethrow
 * on the first failure. */
export const withD1Retry = <T>(op: () => Promise<T>, attempts = 4): Promise<T> =>
	withRetry(op, {
		attempts,
		baseMs: 40,
		shouldRetry: (e) => {
			const transient = isTransientD1Error(e);
			// Surface queue pressure even when the retry succeeds: the
			// 2026-08-22 primary stalls were invisible until reads failed
			// outright, because absorbed retries logged nothing.
			if (transient) console.warn(`transient D1 error, retrying: ${e}`);
			return transient;
		}
	});

/** Prepared-statement execution wrappers that retry transient D1 errors and
 * account statements and rows to the request's latency record. Every
 * read-path, upload-path and touch query goes through these; the remaining
 * raw .run()/.first() sites are rare admin/config statements where a
 * surfaced transient error is fine. */
const instrumented = <T>(
	statements: number,
	run: () => Promise<T>,
	results: (r: T) => D1Result[]
) =>
	measure('d1', () =>
		withD1Retry(async () => {
			countD1(statements);
			const result = await run();
			countD1(0, results(result));
			return result;
		})
	);
export const dbRun = (stmt: D1PreparedStatement) =>
	instrumented(
		1,
		() => stmt.run(),
		(r) => [r]
	);
export const dbAll = <T = unknown>(stmt: D1PreparedStatement) =>
	instrumented(
		1,
		() => stmt.all<T>(),
		(r) => [r]
	);
export const dbFirst = <T = unknown>(stmt: D1PreparedStatement) =>
	dbAll<T>(stmt).then((r) => r.results[0] ?? null);
export const dbBatch = <T = unknown>(db: D1Database, stmts: D1PreparedStatement[]) =>
	instrumented(
		stmts.length,
		() => db.batch<T>(stmts),
		(r) => r
	);

/** Run statements in batches of STMT_BATCH. Only atomic within each batch.
 * Returns one result per statement, in order, so callers can inspect
 * `meta.changes` of a guarded statement. */
export async function runBatched(
	db: D1Database,
	stmts: D1PreparedStatement[]
): Promise<D1Result[]> {
	const results: D1Result[] = [];
	for (let i = 0; i < stmts.length; i += STMT_BATCH) {
		results.push(...(await dbBatch(db, stmts.slice(i, i + STMT_BATCH))));
	}
	return results;
}

/**
 * Session routed to the nearest read replica (D1 Sessions API), isolating the
 * read-heavy serving path from writer contention on the primary. Reads may
 * lag the primary slightly, which callers tolerate — the edge cache already
 * serves far staler data. Writes issued through a session are forwarded to
 * the primary, so passing this anywhere is safe. Falls back to the base
 * binding when sessions are unavailable (replication not enabled).
 */
export function readSession(db: D1Database): D1Database {
	const session = (db as { withSession?: (constraint: string) => unknown }).withSession?.(
		'first-unconstrained'
	);
	return (session ?? db) as D1Database;
}

export interface CacheRow {
	id: number;
	name: string;
	keypair: string;
	is_public: number;
	store_dir: string;
	priority: number;
	upstream_cache_key_names: string;
	compression: string;
	retention_period: number | null;
	retention_max_bytes: number | null;
}

export interface NarRow {
	id: number;
	state: string;
	nar_hash: string;
	nar_size: number;
	compression: string;
	num_chunks: number;
}

export interface ObjectRow {
	id: number;
	store_path_hash: string;
	store_path: string;
	refs: string;
	system: string | null;
	deriver: string | null;
	sigs: string;
	ca: string | null;
}

export interface ChunkRow {
	id: number;
	state: string;
	chunk_hash: string;
	chunk_size: number;
	file_hash: string | null;
	file_size: number | null;
	compression: string;
	remote_file: string;
}

/** Storage key from a chunk's remote_file JSON envelope, null if malformed. */
export function chunkKey(chunk: { remote_file: string }): string | null {
	try {
		return JSON.parse(chunk.remote_file).key ?? null;
	} catch {
		return null;
	}
}

export async function findCache(db: D1Database, name: string): Promise<CacheRow | null> {
	return dbFirst<CacheRow>(
		db
			.prepare(
				'SELECT id, name, keypair, is_public, store_dir, priority, ' +
					'upstream_cache_key_names, compression, retention_period, ' +
					'retention_max_bytes ' +
					'FROM cache WHERE name = ?1 AND deleted_at IS NULL'
			)
			.bind(name)
	);
}

export interface ObjectWithNarChunks {
	object: ObjectRow;
	nar: NarRow;
	chunks: ChunkRow[];
}

export interface NarWithChunks {
	nar: NarRow;
	chunks: ChunkRow[];
}

/** One joined row of object/nar plus (nullable) chunk columns. */
interface JoinedChunkColumns {
	chunk_id: number | null;
	chunk_state: string | null;
	chunk_hash: string | null;
	chunk_size: number | null;
	file_hash: string | null;
	file_size: number | null;
	chunk_compression: string | null;
	remote_file: string | null;
}

const CHUNK_JOIN_COLUMNS =
	'ch.id AS chunk_id, ch.state AS chunk_state, ch.chunk_hash, ch.chunk_size, ' +
	'ch.file_hash, ch.file_size, ch.compression AS chunk_compression, ch.remote_file ';

function chunkFromJoined(row: JoinedChunkColumns): ChunkRow | null {
	if (row.chunk_id == null) return null;
	return {
		id: row.chunk_id,
		state: row.chunk_state!,
		chunk_hash: row.chunk_hash!,
		chunk_size: row.chunk_size!,
		file_hash: row.file_hash,
		file_size: row.file_size,
		compression: row.chunk_compression!,
		remote_file: row.remote_file!
	};
}

/**
 * Object, its NAR, and the NAR's chunks in one round-trip (the cold narinfo
 * path is latency-sensitive: it runs once per store path of a closure walk).
 * Chunkrefs with a missing chunk row yield no ChunkRow; callers compare
 * chunks.length against nar.num_chunks for completeness.
 */
export async function findObjectWithChunks(
	db: D1Database,
	cacheName: string,
	storePathHash: string
): Promise<ObjectWithNarChunks | null> {
	const { results } = await dbAll<
		ObjectRow & {
			nar_id: number;
			nar_state: string;
			nar_hash: string;
			nar_size: number;
			nar_compression: string;
			num_chunks: number;
		} & JoinedChunkColumns
	>(
		db
			.prepare(
				'SELECT o.id, o.store_path_hash, o.store_path, o.refs, o.system, o.deriver, ' +
					'o.sigs, o.ca, ' +
					'n.id AS nar_id, n.state AS nar_state, n.nar_hash, n.nar_size, ' +
					'n.compression AS nar_compression, n.num_chunks, ' +
					CHUNK_JOIN_COLUMNS +
					'FROM object o ' +
					'INNER JOIN cache c ON o.cache_id = c.id ' +
					'INNER JOIN nar n ON o.nar_id = n.id ' +
					'LEFT JOIN chunkref cr ON cr.nar_id = n.id ' +
					'LEFT JOIN chunk ch ON ch.id = cr.chunk_id ' +
					"WHERE c.name = ?1 AND c.deleted_at IS NULL AND o.store_path_hash = ?2 AND n.state = 'V' " +
					'ORDER BY cr.seq'
			)
			.bind(cacheName, storePathHash)
	);
	const first = results[0];
	if (!first) return null;
	return {
		object: {
			id: first.id,
			store_path_hash: first.store_path_hash,
			store_path: first.store_path,
			refs: first.refs,
			system: first.system,
			deriver: first.deriver,
			sigs: first.sigs,
			ca: first.ca
		},
		nar: {
			id: first.nar_id,
			state: first.nar_state,
			nar_hash: first.nar_hash,
			nar_size: first.nar_size,
			compression: first.nar_compression,
			num_chunks: first.num_chunks
		},
		chunks: results.map(chunkFromJoined).filter((c): c is ChunkRow => c !== null)
	};
}

/**
 * Valid NAR and its chunks in one round-trip, matching any of the given hash
 * spellings (earlier entries win, e.g. `sha256:`-prefixed before bare).
 *
 * `cacheId` restricts the match to NARs some object in that cache references.
 * NAR bodies are content-addressed, so the unscoped form is what lets every
 * public cache share one edge entry and one R2 read — but it resolves by hash
 * across the whole instance, while the gateway only ever authorized the cache
 * named in the URL. Entitlement is therefore re-established here, from both
 * sides: the unscoped form matches only NARs reachable from a live public
 * cache (bytes any public-cache reader is entitled to), so pull on a public
 * cache plus knowledge of a nar hash cannot read a NAR held only by a private
 * one; private caches take the scoped form (see narStoreUrl in store.ts),
 * which is how their own authorized requests still resolve — with the cache
 * id in the edge key, so the resulting entry is out of reach of requests
 * authorized against any other cache.
 *
 * Scoping is by id rather than name because names are reusable
 * (purgeDeletedCache) while ids are AUTOINCREMENT and never are — the same
 * reason destroyCache drops the old name's grants. The scoped form needs no
 * join back to `cache`: the id always comes from a row the caller already
 * resolved through a deleted_at IS NULL filter.
 */
export async function findNarWithChunks(
	db: D1Database,
	narHashes: string[],
	cacheId?: number
): Promise<NarWithChunks | null> {
	const placeholders = narHashes.map((_, i) => `?${i + 1}`).join(', ');
	// Bind list first so the scope placeholder index falls out of it rather
	// than being computed twice and kept in sync by hand.
	const args: (string | number)[] = [...narHashes];
	if (cacheId !== undefined) args.push(cacheId);
	const scope =
		cacheId === undefined
			? 'AND EXISTS (SELECT 1 FROM object o JOIN cache c ON c.id = o.cache_id ' +
				'WHERE o.nar_id = n.id AND c.is_public = 1 AND c.deleted_at IS NULL) '
			: `AND EXISTS (SELECT 1 FROM object o WHERE o.nar_id = n.id AND o.cache_id = ?${args.length}) `;
	const { results } = await dbAll<
		{
			nar_id: number;
			nar_state: string;
			nar_hash: string;
			nar_size: number;
			nar_compression: string;
			num_chunks: number;
		} & JoinedChunkColumns
	>(
		db
			.prepare(
				'SELECT n.id AS nar_id, n.state AS nar_state, n.nar_hash, n.nar_size, ' +
					'n.compression AS nar_compression, n.num_chunks, ' +
					CHUNK_JOIN_COLUMNS +
					'FROM nar n ' +
					'LEFT JOIN chunkref cr ON cr.nar_id = n.id ' +
					'LEFT JOIN chunk ch ON ch.id = cr.chunk_id ' +
					`WHERE n.nar_hash IN (${placeholders}) AND n.state = 'V' ` +
					scope +
					'ORDER BY n.id, cr.seq'
			)
			.bind(...args)
	);
	if (results.length === 0) return null;
	// Prefer the earliest hash spelling that matched, then the lowest nar id.
	const rank = new Map(narHashes.map((h, i) => [h, i]));
	results.sort(
		(a, b) =>
			(rank.get(a.nar_hash) ?? Infinity) - (rank.get(b.nar_hash) ?? Infinity) || a.nar_id - b.nar_id
	);
	const chosen = results[0].nar_id;
	const rows = results.filter((r) => r.nar_id === chosen);
	return {
		nar: {
			id: rows[0].nar_id,
			state: rows[0].nar_state,
			nar_hash: rows[0].nar_hash,
			nar_size: rows[0].nar_size,
			compression: rows[0].nar_compression,
			num_chunks: rows[0].num_chunks
		},
		chunks: rows.map(chunkFromJoined).filter((c): c is ChunkRow => c !== null)
	};
}

/**
 * Granularity of the download-touch write: an object touched more recently
 * than this is not touched again.
 *
 * This is what keeps read throughput off the D1 write primary. shouldTouch
 * (proxy.ts) coalesces per isolate, which collapses under exactly the load it
 * matters for: a wide cold pull spreads across many colos and isolates, each
 * seeing a given NAR about once, so per-isolate coalescing approaches one
 * touch per NAR GET — the write rate then tracks read volume and competes
 * with uploads for the single primary. This window makes it
 * O(distinct objects per window) instead, independent of isolate count, colo
 * count, and fleet size.
 *
 * One hour rather than something longer because retention's floor is
 * `retention_period = 1` day: at 6h a just-missed touch could cost such a
 * cache a quarter of its window. At 1h the worst-case early eviction is ~4%
 * of the shortest usable retention, and the write reduction is still ~24x per
 * object per day against an unbounded per-request touch.
 */
export const TOUCH_GRANULARITY_MS = 60 * 60 * 1000;

// ?1 cache id, ?2/?3 nar hash spellings, ?4 recency cutoff — shared by the
// probe and the write so the two can never test different predicates.
const TOUCH_MATCH_SQL =
	'cache_id = ?1 ' +
	"AND nar_id IN (SELECT id FROM nar WHERE nar_hash IN (?2, ?3) AND state = 'V') " +
	'AND (last_accessed_at IS NULL OR last_accessed_at < ?4)';
const TOUCH_PROBE_SQL = `SELECT 1 FROM object WHERE ${TOUCH_MATCH_SQL} LIMIT 1`;
const TOUCH_UPDATE_SQL = `UPDATE object SET last_accessed_at = ?5 WHERE ${TOUCH_MATCH_SQL}`;

/**
 * Bump last_accessed_at for every object in a cache backed by the NAR with
 * this hash (bare or sha256:-prefixed), unless it was already touched within
 * TOUCH_GRANULARITY_MS. NAR URLs carry the nar hash rather than a store path
 * hash, so a download can only be attributed at NAR granularity (like the
 * reference server's touch-on-download semantics). Keyed by nar hash rather
 * than nar id so the gateway can touch without resolving the NAR row it no
 * longer needs for serving.
 *
 * The staleness check runs on a REPLICA and the UPDATE is issued only when it
 * will actually write. Putting the recency predicate on the UPDATE alone
 * bounds rows written but not statements: writes route to the single primary
 * whether or not they match, so a no-op UPDATE still occupies its request
 * queue — the resource that surfaces as "D1 requests queued for too long"
 * under a wide pull. Deciding on a replica moves the per-request work onto
 * horizontally-scaled reads and leaves the primary seeing roughly one
 * statement per object per window. The UPDATE keeps the predicate anyway, so
 * two isolates racing the same window still write once each at most, and
 * replica lag costs only a redundant write that would have happened regardless.
 *
 * Both statements are raw, per the best-effort carve-out documented on
 * dbRun/dbFirst above: a touch that fails is skipped and the next download
 * re-decides, so retrying would only add load to a primary or replica that is
 * already signalling contention.
 */
export async function touchObjectsForNarHash(
	db: D1Database,
	cacheId: number,
	narHashRaw: string
): Promise<void> {
	const now = Date.now();
	const args = [
		cacheId,
		`sha256:${narHashRaw}`,
		narHashRaw,
		new Date(now - TOUCH_GRANULARITY_MS).toISOString()
	];

	const stale = await dbFirst(
		readSession(db)
			.prepare(TOUCH_PROBE_SQL)
			.bind(...args)
	);
	if (!stale) return;
	await dbRun(db.prepare(TOUCH_UPDATE_SQL).bind(...args, new Date(now).toISOString()));
}

/** Pin a store path's closure against garbage collection. */
export async function addGcRoot(
	db: D1Database,
	cacheId: number,
	storePathHash: string,
	note: string | null
): Promise<void> {
	await db
		.prepare(
			'INSERT OR IGNORE INTO gc_root (cache_id, store_path_hash, note, created_at) VALUES (?1, ?2, ?3, ?4)'
		)
		.bind(cacheId, storePathHash, note, new Date().toISOString())
		.run();
}

/** Remove an anonymous GC pin; returns false when nothing was pinned. Named
 * pins are removed by name (removePin) — their revisions are not reachable
 * from a bare hash. */
export async function removeGcRoot(
	db: D1Database,
	cacheId: number,
	storePathHash: string
): Promise<boolean> {
	const result = await db
		.prepare('DELETE FROM gc_root WHERE cache_id = ?1 AND store_path_hash = ?2 AND pin_id IS NULL')
		.bind(cacheId, storePathHash)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/** Pin names appear in URLs and forms: printable, no whitespace, bounded.
 * One spelling shared by the API route and the settings action. */
export const PIN_NAME_RE = /^\S{1,100}$/;

/** nix-base32 store path hash (32 chars, alphabet excludes e/o/u/t). */
export const STORE_PATH_HASH_RE = /^[0-9a-df-np-sv-z]{32}$/;

/**
 * Create or re-point a named pin (cachix-style). Re-pinning the name adds a
 * revision (a gc_root row owned by the pin); re-pinning an existing revision
 * refreshes its recency so keep_revisions ordering treats it as newest.
 * Omitted keep options and notes preserve the pin's current values.
 */
export async function upsertPin(
	db: D1Database,
	cacheId: number,
	name: string,
	storePathHash: string,
	opts: { keepRevisions?: number; keepDays?: number; note?: string | null } = {}
): Promise<void> {
	const now = nowRfc3339();
	// One transaction: the gc_root insert resolves the pin id created/found
	// by the statement before it.
	await db.batch([
		db
			.prepare(
				'INSERT INTO pin (cache_id, name, keep_revisions, keep_days, created_at) ' +
					'VALUES (?1, ?2, ?3, ?4, ?5) ' +
					'ON CONFLICT (cache_id, name) DO UPDATE SET ' +
					'keep_revisions = COALESCE(?3, pin.keep_revisions), ' +
					'keep_days = COALESCE(?4, pin.keep_days)'
			)
			.bind(cacheId, name, opts.keepRevisions ?? null, opts.keepDays ?? null, now),
		db
			.prepare(
				'INSERT INTO gc_root (cache_id, store_path_hash, note, pin_id, created_at) ' +
					'SELECT ?1, ?2, ?3, id, ?4 FROM pin WHERE cache_id = ?1 AND name = ?5 ' +
					'ON CONFLICT (pin_id, store_path_hash) WHERE pin_id IS NOT NULL ' +
					'DO UPDATE SET created_at = excluded.created_at, ' +
					'note = COALESCE(excluded.note, gc_root.note)'
			)
			.bind(cacheId, storePathHash, opts.note ?? null, now, name)
	]);
}

/** Remove a named pin and all its revisions; returns false when no pin matched. */
export async function removePin(db: D1Database, cacheId: number, name: string): Promise<boolean> {
	const results = await db.batch([
		db
			.prepare(
				'DELETE FROM gc_root WHERE pin_id = (SELECT id FROM pin WHERE cache_id = ?1 AND name = ?2)'
			)
			.bind(cacheId, name),
		db.prepare('DELETE FROM pin WHERE cache_id = ?1 AND name = ?2').bind(cacheId, name)
	]);
	return (results[1]?.meta.changes ?? 0) > 0;
}

/**
 * Whether an admin-issued token (by jti) is revoked or suspended. Suspension
 * follows the owner's activation status (isActiveUser): a deactivated user's
 * tokens stop working immediately and resume if the account is reactivated.
 * Missing rows are valid (e.g. bootstrap tokens the admin app never tracked).
 */
export async function isTokenDisabled(db: D1Database, jti: string): Promise<boolean> {
	const row = await dbFirst<{
		revoked_at: string | null;
		status: string | null;
		role: string | null;
	}>(
		db
			.prepare(
				`SELECT t.revoked_at, u.status, u.role
				 FROM api_token t LEFT JOIN user u ON u.id = t.user_id
				 WHERE t.id = ?1`
			)
			.bind(jti)
	);
	if (!row) return false;
	if (row.revoked_at != null) return true;
	return row.status != null && !isActiveUser({ role: row.role ?? 'member', status: row.status });
}

// --- Write side (uploads, cache config), mirroring the Rust worker's d1.rs ---

export interface NewNar {
	state: string;
	nar_hash: string;
	nar_size: number;
	compression: string;
	num_chunks: number;
}

export async function createNar(db: D1Database, nar: NewNar): Promise<number> {
	// holders_count 0: a fresh 'P' row is protected from the orphan reaper by
	// its 1h grace period until the linking batch lands the object row.
	const stmt = db
		.prepare(
			'INSERT INTO nar (state, nar_hash, nar_size, compression, num_chunks, ' +
				'completeness_hint, holders_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)'
		)
		.bind(nar.state, nar.nar_hash, nar.nar_size, nar.compression, nar.num_chunks, nowRfc3339());
	const result = await dbRun(stmt);
	return requireRowId(result, 'nar');
}

export interface NewChunk {
	state: string;
	chunk_hash: string;
	chunk_size: number;
	file_hash: string | null;
	file_size: number | null;
	compression: string;
	remote_file: string;
	remote_file_id: string;
}

// Share vs. take over on a (chunk_hash, compression) conflict. Sharing bumps
// the hold on a row whose bytes match ours: a valid row, or a pending row
// staged from the same compressed bytes (a concurrent identical upload). Any
// other pending or deleted row is dead once nobody holds it or its hold has
// aged past any live upload: a pending row from a different encoder (client
// klauspost zstd vs. server wasm zstd yield different bytes for the same raw
// chunk) whose PUT failed, a request killed mid-PUT, or a GC claim whose R2
// delete failed. Taking it over rewrites the row for our bytes and restarts
// the reaper's grace period. Without the takeover branch such rows blocked
// every re-push of that chunk until the nightly GC (or, for held rows, the
// stale-hold reset a day later). The displaced key may hold a fully written
// object (a PUT that succeeded but never published), so the takeover journals
// it in chunk_repair, in the same transaction, for retirement.
const chunkShare = (fileHash: string, fileSize: string) =>
	`(chunk.state = 'V' OR (chunk.state = 'P' AND chunk.file_hash IS ${fileHash} AND chunk.file_size IS ${fileSize}))`;
const CHUNK_SHARE = chunkShare('excluded.file_hash', 'excluded.file_size');
const CHUNK_HOLD_AGED =
	"(chunk.held_at IS NULL OR datetime(chunk.held_at) < datetime('now', '-1 hours'))";
// A D row always has holders_count 0 (that is what made it claimable), so
// only age releases it: GC's R2 delete batch has long finished by then.
const CHUNK_TAKEOVER =
	`((chunk.state = 'P' AND (chunk.holders_count = 0 OR ${CHUNK_HOLD_AGED})) ` +
	`OR (chunk.state = 'D' AND ${CHUNK_HOLD_AGED}))`;

/** Record ownership before R2 PUT so an interrupted upload remains reapable.
 * Returns null only for a live pending row with different compressed bytes
 * (a concurrent upload from another encoder); that clears within seconds. */
export async function stageChunk(db: D1Database, chunk: NewChunk): Promise<ChunkRow | null> {
	const keep = (col: string) =>
		`${col} = CASE WHEN ${CHUNK_SHARE} THEN chunk.${col} ELSE excluded.${col} END`;
	// Same predicates as the upsert below, evaluated in the same transaction:
	// this row exists exactly when the upsert takes the existing row over.
	const journal = db
		.prepare(
			'INSERT OR IGNORE INTO chunk_repair (new_key, chunk_id, old_key, retire_after) ' +
				'SELECT ?1, id, remote_file_id, ?2 FROM chunk WHERE chunk_hash = ?3 AND compression = ?4 ' +
				`AND NOT ${chunkShare('?5', '?6')} AND ${CHUNK_TAKEOVER} AND remote_file_id IS NOT NULL`
		)
		.bind(
			chunk.remote_file_id,
			Date.now(),
			chunk.chunk_hash,
			chunk.compression,
			chunk.file_hash,
			chunk.file_size
		);
	const [, staged] = await dbBatch<ChunkRow>(db, [
		journal,
		db
			.prepare(
				'INSERT INTO chunk (state, chunk_hash, chunk_size, file_hash, file_size, compression, remote_file, remote_file_id, holders_count, held_at, created_at) ' +
					"VALUES ('P', ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8) " +
					'ON CONFLICT (chunk_hash, compression) DO UPDATE SET ' +
					`holders_count = CASE WHEN ${CHUNK_SHARE} THEN chunk.holders_count + 1 ELSE 1 END, ` +
					`state = CASE WHEN ${CHUNK_SHARE} THEN chunk.state ELSE 'P' END, ` +
					[
						keep('chunk_size'),
						keep('file_hash'),
						keep('file_size'),
						keep('remote_file'),
						keep('remote_file_id'),
						keep('created_at')
					].join(', ') +
					', held_at = excluded.held_at ' +
					`WHERE ${CHUNK_SHARE} OR ${CHUNK_TAKEOVER} ` +
					'RETURNING id, state, chunk_hash, chunk_size, file_hash, file_size, compression, remote_file'
			)
			.bind(
				chunk.chunk_hash,
				chunk.chunk_size,
				chunk.file_hash,
				chunk.file_size,
				chunk.compression,
				chunk.remote_file,
				chunk.remote_file_id,
				nowRfc3339()
			)
	]);
	return staged.results[0] ?? null;
}

/**
 * Chunk repair. A valid row's stored object can vanish (GC raced an upload)
 * or fail verification; the row's `remote_file` is the version token for
 * both transitions, so they are safe across isolates without any shared
 * lock: each one applies only if the row still names the object the caller
 * observed, and a concurrent repair that already moved the row makes the
 * late caller a no-op.
 */

/** Completion observed bytes under `remoteFile` that contradict the row.
 * Clears the file metadata (size unknown, hash unknown) so the chunk PUT's
 * repair path claims it even though the object is still present. */
export async function markChunkDamaged(
	db: D1Database,
	id: number,
	remoteFile: string
): Promise<boolean> {
	const result = await dbRun(
		db
			.prepare(
				'UPDATE chunk SET file_hash = NULL, file_size = NULL WHERE id = ?1 AND remote_file = ?2'
			)
			.bind(id, remoteFile)
	);
	return (result.meta?.changes ?? 0) > 0;
}

/** The pointer and retirement job commit together. The journal also witnesses
 * a successful CAS whose response was lost, even if a later repair won. */
export async function repairChunkFile(
	db: D1Database,
	id: number,
	expectedRemoteFile: string,
	file: { remote_file: string; remote_file_id: string; file_hash: string; file_size: number }
): Promise<boolean> {
	const results = await dbBatch(db, [
		db
			.prepare(
				"UPDATE chunk SET remote_file = ?1, remote_file_id = ?2, file_hash = ?3, file_size = ?4 WHERE id = ?5 AND remote_file = ?6 AND state = 'V'"
			)
			.bind(
				file.remote_file,
				file.remote_file_id,
				file.file_hash,
				file.file_size,
				id,
				expectedRemoteFile
			),
		db
			.prepare(
				"INSERT OR IGNORE INTO chunk_repair (new_key, chunk_id, old_key) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM chunk WHERE id = ?2 AND remote_file = ?4 AND state = 'V')"
			)
			.bind(
				file.remote_file_id,
				id,
				chunkKey({ remote_file: expectedRemoteFile }),
				file.remote_file
			),
		db.prepare('SELECT 1 FROM chunk_repair WHERE new_key = ?1').bind(file.remote_file_id)
	]);
	return results[2].results.length > 0;
}

export interface ChunkRepair {
	new_key: string;
	chunk_id: number;
	old_key: string | null;
	object_cursor: number;
	retire_after: number | null;
}

/** Keyset pagination bounds each purge call, never the total fan-out. */
export async function objectsReferencingChunk(
	db: D1Database,
	chunkId: number,
	after: number,
	limit: number
) {
	return (
		await dbAll<{ id: number; cache_name: string; store_path_hash: string; nar_hash: string }>(
			db
				.prepare(
					'SELECT DISTINCT o.id, c.name AS cache_name, o.store_path_hash, n.nar_hash FROM chunkref cr ' +
						'JOIN nar n ON n.id = cr.nar_id JOIN object o ON o.nar_id = n.id ' +
						'JOIN cache c ON c.id = o.cache_id WHERE cr.chunk_id = ?1 AND o.id > ?2 ORDER BY o.id LIMIT ?3'
				)
				.bind(chunkId, after, limit)
		)
	).results;
}

/** Statement form so a NAR's fresh chunks publish inside the link batch —
 * one primary transaction per NAR instead of one per chunk. Idempotent. */
export function publishChunkStmt(db: D1Database, id: number): D1PreparedStatement {
	return db.prepare("UPDATE chunk SET state = 'V' WHERE id = ?1 AND state = 'P'").bind(id);
}

export async function publishChunk(db: D1Database, id: number): Promise<void> {
	await dbRun(publishChunkStmt(db, id));
}

/** Publish fresh rows and drop holds in one batch: the tail of every upload
 * path, success or failure. A chunk whose bytes reached R2 is valid content
 * whatever became of the NAR (content-addressed, adopted by any retry), so
 * publishing on failure paths is deliberate. For a chunk stored ahead of the
 * NAR that will reference it (CDC PUTs) the reaper's grace period protects
 * the unheld row until complete links it. */
export async function settleChunks(
	db: D1Database,
	chunks: { id: number; publish: boolean }[]
): Promise<void> {
	if (chunks.length === 0) return;
	await runBatched(
		db,
		chunks.map(({ id, publish }) =>
			publish
				? db
						.prepare(
							"UPDATE chunk SET state = CASE WHEN state = 'P' THEN 'V' ELSE state END, " +
								'holders_count = MAX(holders_count - 1, 0) WHERE id = ?1'
						)
						.bind(id)
				: releaseChunkLockStmt(db, id)
		)
	);
}

/** The GC mutex serializes reapers; this claim serializes GC against uploads
 * (stageChunk refuses a freshly claimed row). held_at stamps the claim so a
 * D row whose R2 delete failed becomes adoptable again an hour later instead
 * of blocking re-pushes until the next successful nightly run. */
export async function claimOrphanChunks(
	db: D1Database
): Promise<{ id: number; remote_file: string }[]> {
	return (
		await dbAll<{ id: number; remote_file: string }>(
			db
				.prepare(
					"UPDATE chunk SET state = 'D', held_at = ?1 WHERE holders_count = 0 " +
						'AND NOT EXISTS (SELECT 1 FROM chunkref cr WHERE cr.chunk_id = chunk.id) ' +
						"AND datetime(created_at) < datetime('now', '-1 hours') RETURNING id, remote_file"
				)
				.bind(nowRfc3339())
		)
	).results;
}

/** Valid chunk row for (hash, compression), without taking a hold. */
export async function findChunk(
	db: D1Database,
	chunkHash: string,
	compression: string
): Promise<ChunkRow | null> {
	return dbFirst<ChunkRow>(
		db
			.prepare(
				'SELECT id, state, chunk_hash, chunk_size, file_hash, file_size, compression, remote_file ' +
					"FROM chunk WHERE chunk_hash = ?1 AND compression = ?2 AND state = 'V'"
			)
			.bind(chunkHash, compression)
	);
}

/** An idempotent CDC retry must not take holds, upsert, or purge caches. */
export async function hasAttachedNar(
	db: D1Database,
	cacheId: number,
	pathHash: string,
	narHash: string
): Promise<boolean> {
	return !!(await dbFirst(
		db
			.prepare(
				"SELECT 1 FROM object o JOIN nar n ON n.id = o.nar_id WHERE o.cache_id = ?1 AND o.store_path_hash = ?2 AND o.detached_at IS NULL AND n.state = 'V' AND n.nar_hash = ?3 LIMIT 1"
			)
			.bind(cacheId, pathHash, narHash)
	));
}

/**
 * Chunkref insert for atomic batches. When chunkId is null the row links to
 * whichever chunk row won (chunk_hash, compression) — deterministic under the
 * unique index, and non-null as long as the chunk insert precedes it in the
 * same or an earlier batch.
 */
export function insertChunkRefStmt(
	db: D1Database,
	narId: number,
	seq: number,
	chunkId: number | null,
	chunkHash: string,
	compression: string
): D1PreparedStatement {
	return db
		.prepare(
			'INSERT INTO chunkref (nar_id, seq, chunk_id, chunk_hash, compression) ' +
				'VALUES (?1, ?2, COALESCE(?3, ' +
				'(SELECT id FROM chunk WHERE chunk_hash = ?4 AND compression = ?5)), ?4, ?5)'
		)
		.bind(narId, seq, chunkId, chunkHash, compression);
}

export interface NewObject {
	publishTrust?: { upstreamId: number; publicKey: string; url: string };
	cache_id: number;
	nar_id: number;
	store_path_hash: string;
	store_path: string;
	references: string[];
	system: string | null;
	deriver: string | null;
	sigs: string[];
	ca: string | null;
	/** Provenance: 'push' or 'pullthrough:<upstream url>'. */
	source: string | null;
	/** Pushing token's subject; null for pull-through ingests. */
	created_by: string | null;
}

export function insertObjectStmt(db: D1Database, object: NewObject): D1PreparedStatement {
	return db
		.prepare(
			'INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, ' +
				'refs, system, deriver, sigs, ca, created_at, created_by, source) ' +
				'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 WHERE ' +
				(object.publishTrust
					? "EXISTS (SELECT 1 FROM upstream u JOIN cache c ON c.id = ?1 LEFT JOIN cache_upstream cu ON cu.cache_id = c.id AND cu.upstream_id = u.id WHERE u.id = ?13 AND u.public_key = ?14 AND u.url = ?15 AND c.deleted_at IS NULL AND COALESCE(cu.mode, u.default_mode) = 'persist') "
					: '1 ') +
				// Re-pushing revives a detached (removed) path.
				'ON CONFLICT (cache_id, store_path_hash) DO UPDATE SET nar_id = excluded.nar_id, ' +
				'detached_at = NULL, source = excluded.source, created_by = excluded.created_by ' +
				'WHERE object.nar_id <> excluded.nar_id OR object.detached_at IS NOT NULL'
		)
		.bind(
			object.cache_id,
			object.nar_id,
			object.store_path_hash,
			object.store_path,
			JSON.stringify(object.references),
			object.system,
			object.deriver,
			JSON.stringify(object.sigs),
			object.ca,
			nowRfc3339(),
			object.created_by,
			object.source,
			...(object.publishTrust
				? [object.publishTrust.upstreamId, object.publishTrust.publicKey, object.publishTrust.url]
				: [])
		);
}

/** Insert or revive the object row. Returns false only when a publishTrust
 * guard rejected it. */
export async function createObject(db: D1Database, object: NewObject): Promise<boolean> {
	const result = await dbRun(insertObjectStmt(db, object));
	return objectPublished(db, object, result);
}

/**
 * Whether a guarded insert published. Zero changed rows is ambiguous: the
 * guard's SELECT produced no row (trust rejected), or the ON CONFLICT update
 * skipped an attachment that already matches (an idempotent re-publish, e.g.
 * two ingests of one path racing). Only the second leaves the object row
 * attached to this NAR, so that is what decides. */
export async function objectPublished(
	db: D1Database,
	object: NewObject,
	result: D1Result
): Promise<boolean> {
	if (!object.publishTrust || (result.meta?.changes ?? 0) > 0) return true;
	const attached = await dbFirst(
		db
			.prepare(
				'SELECT 1 FROM object WHERE cache_id = ?1 AND store_path_hash = ?2 AND nar_id = ?3 AND detached_at IS NULL'
			)
			.bind(object.cache_id, object.store_path_hash, object.nar_id)
	);
	return attached !== null;
}

export function updateNarStateStmt(
	db: D1Database,
	narId: number,
	state: string
): D1PreparedStatement {
	return db.prepare('UPDATE nar SET state = ?1 WHERE id = ?2').bind(state, narId);
}

export async function updateNarState(db: D1Database, narId: number, state: string): Promise<void> {
	await dbRun(updateNarStateStmt(db, narId, state));
}

export type ChunkHolder = { name: string; is_public: number };

/** Live caches whose attached, valid NARs disclose each chunk's bytes.
 * Batch IN-list windows together to avoid a replica round-trip per window. */
export async function cachesHoldingChunks(
	db: D1Database,
	chunkHashes: string[],
	compression: string
): Promise<Map<string, ChunkHolder[]>> {
	const holders = new Map<string, ChunkHolder[]>();
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < chunkHashes.length; i += PARAM_BATCH) {
		const batch = chunkHashes.slice(i, i + PARAM_BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		stmts.push(
			db
				.prepare(
					'SELECT DISTINCT ch.chunk_hash, c.name, c.is_public FROM chunk ch ' +
						'JOIN chunkref cr ON cr.chunk_id = ch.id ' +
						"JOIN nar n ON n.id = cr.nar_id AND n.state = 'V' " +
						'JOIN object o ON o.nar_id = n.id AND o.detached_at IS NULL ' +
						'JOIN cache c ON c.id = o.cache_id AND c.deleted_at IS NULL ' +
						`WHERE ch.compression = ?1 AND ch.state = 'V' AND ch.chunk_hash IN (${placeholders})`
				)
				.bind(compression, ...batch)
		);
	}
	for (let i = 0; i < stmts.length; i += STMT_BATCH) {
		for (const result of await dbBatch<ChunkHolder & { chunk_hash: string }>(
			db,
			stmts.slice(i, i + STMT_BATCH)
		)) {
			for (const row of result.results) {
				const list = holders.get(row.chunk_hash) ?? [];
				list.push({ name: row.name, is_public: row.is_public });
				holders.set(row.chunk_hash, list);
			}
		}
	}
	return holders;
}

// Row shape shared by findValidNar's SELECT and tryLockNar's RETURNING — the
// probe/lock pair must agree on it (same idea as CHUNK_JOIN_COLUMNS above).
const NAR_ROW_COLUMNS = 'id, state, nar_hash, nar_size, compression, num_chunks';

/** Valid NAR row by hash, without taking a hold — the replica-side existence
 * probe for tryLockNarProbed (upload.ts), which owns the probe-then-lock
 * rationale. */
export async function findValidNar(db: D1Database, narHash: string): Promise<NarRow | null> {
	return dbFirst<NarRow>(
		db
			.prepare(
				`SELECT ${NAR_ROW_COLUMNS} FROM nar WHERE nar_hash = ?1 AND state = 'V' ORDER BY id LIMIT 1`
			)
			.bind(narHash)
	);
}

/**
 * Dedup hold: atomically bump holders_count on the valid NAR row, returning
 * it, or null when none exists. The orphan reaper skips held rows, so a NAR
 * locked here cannot be reaped between the dedup decision and the object row
 * landing — release with releaseNarLock when done.
 */
export async function tryLockNar(db: D1Database, narHash: string): Promise<NarRow | null> {
	const stmt = db
		.prepare(
			'UPDATE nar SET holders_count = holders_count + 1, held_at = ?2 ' +
				"WHERE id = (SELECT id FROM nar WHERE nar_hash = ?1 AND state = 'V' ORDER BY id LIMIT 1) " +
				`RETURNING ${NAR_ROW_COLUMNS}`
		)
		.bind(narHash, nowRfc3339());
	const row = await dbFirst<NarRow>(stmt);
	return row ?? null;
}

export async function releaseNarLock(db: D1Database, narId: number): Promise<void> {
	await db
		.prepare('UPDATE nar SET holders_count = holders_count - 1 WHERE id = ?1 AND holders_count > 0')
		.bind(narId)
		.run();
}

/**
 * Chunk-level dedup hold, the chunk analog of tryLockNar. Matches on hash AND
 * compression (a chunk stored with a different codec is a different file).
 */
function tryLockChunkStmt(
	db: D1Database,
	chunkHash: string,
	compression: string
): D1PreparedStatement {
	return db
		.prepare(
			'UPDATE chunk SET holders_count = holders_count + 1, held_at = ?3 ' +
				'WHERE id = (SELECT id FROM chunk ' +
				"WHERE chunk_hash = ?1 AND compression = ?2 AND state = 'V') " +
				'RETURNING id, state, chunk_hash, chunk_size, file_hash, file_size, compression, remote_file'
		)
		.bind(chunkHash, compression, nowRfc3339());
}

export async function tryLockChunk(
	db: D1Database,
	chunkHash: string,
	compression: string
): Promise<ChunkRow | null> {
	const row = await dbFirst<ChunkRow>(tryLockChunkStmt(db, chunkHash, compression));
	return row ?? null;
}

/** Lock many chunks in one batch round-trip; returns rows keyed by chunk_hash. */
export async function tryLockChunks(
	db: D1Database,
	chunkHashes: string[],
	compression: string
): Promise<Map<string, ChunkRow>> {
	const locked = new Map<string, ChunkRow>();
	for (let i = 0; i < chunkHashes.length; i += STMT_BATCH) {
		const window = chunkHashes.slice(i, i + STMT_BATCH);
		const results = await dbBatch<ChunkRow>(
			db,
			window.map((hash) => tryLockChunkStmt(db, hash, compression))
		);
		for (const result of results) {
			const row = result.results?.[0];
			if (row) locked.set(row.chunk_hash, row);
		}
	}
	return locked;
}

function releaseChunkLockStmt(db: D1Database, chunkId: number): D1PreparedStatement {
	return db
		.prepare(
			'UPDATE chunk SET holders_count = holders_count - 1 WHERE id = ?1 AND holders_count > 0'
		)
		.bind(chunkId);
}

/** Release many chunk holds in one batch round-trip. */
export async function releaseChunkLocksById(db: D1Database, chunkIds: number[]): Promise<void> {
	if (chunkIds.length === 0) return;
	await runBatched(
		db,
		chunkIds.map((id) => releaseChunkLockStmt(db, id))
	);
}

export interface CacheUpdate {
	is_public?: boolean;
	store_dir?: string;
	priority?: number;
	compression?: string;
	/** undefined = leave unchanged; null = clear. */
	retention_period?: number | null;
	/** undefined = leave unchanged; null = clear. */
	retention_max_bytes?: number | null;
	upstream_cache_key_names?: string[];
	keypair?: string;
}

export async function updateCache(
	db: D1Database,
	name: string,
	update: CacheUpdate
): Promise<void> {
	const sets: string[] = [];
	const params: unknown[] = [];
	const push = (column: string, value: unknown) => {
		sets.push(`${column} = ?${params.length + 1}`);
		params.push(value);
	};
	if (update.is_public !== undefined) push('is_public', update.is_public ? 1 : 0);
	if (update.store_dir !== undefined) push('store_dir', update.store_dir);
	if (update.priority !== undefined) push('priority', update.priority);
	if (update.compression !== undefined) push('compression', update.compression);
	if ('retention_period' in update) push('retention_period', update.retention_period ?? null);
	if ('retention_max_bytes' in update)
		push('retention_max_bytes', update.retention_max_bytes ?? null);
	if (update.upstream_cache_key_names !== undefined)
		push('upstream_cache_key_names', JSON.stringify(update.upstream_cache_key_names));
	if (update.keypair !== undefined) push('keypair', update.keypair);
	if (sets.length === 0) return;

	params.push(name);
	await db
		.prepare(
			`UPDATE cache SET ${sets.join(', ')} WHERE name = ?${params.length} AND deleted_at IS NULL`
		)
		.bind(...params)
		.run();
}

export interface NewCache {
	name: string;
	keypair: string;
	is_public: boolean;
	store_dir: string;
	priority: number;
	compression: string;
	retention_period: number | null;
}

export async function createCacheRow(db: D1Database, cache: NewCache): Promise<void> {
	await db
		.prepare(
			'INSERT INTO cache (name, keypair, is_public, store_dir, priority, ' +
				"upstream_cache_key_names, compression, created_at) VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7) " +
				'ON CONFLICT (name) DO NOTHING'
		)
		.bind(
			cache.name,
			cache.keypair,
			cache.is_public ? 1 : 0,
			cache.store_dir,
			cache.priority,
			cache.compression,
			nowRfc3339()
		)
		.run();
	if (cache.retention_period != null) {
		await db
			.prepare('UPDATE cache SET retention_period = ?1 WHERE name = ?2')
			.bind(cache.retention_period, cache.name)
			.run();
	}
}

/** Soft-delete; returns false when no live cache matched. */
export async function softDeleteCache(db: D1Database, name: string): Promise<boolean> {
	const result = await db
		.prepare('UPDATE cache SET deleted_at = ?1 WHERE name = ?2 AND deleted_at IS NULL')
		.bind(nowRfc3339(), name)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export type RenameOutcome = 'renamed' | 'not_found' | 'conflict';

export async function renameCacheRow(
	db: D1Database,
	oldName: string,
	newName: string
): Promise<RenameOutcome> {
	const taken = await db
		.prepare('SELECT 1 AS x FROM cache WHERE name = ?1 AND deleted_at IS NULL')
		.bind(newName)
		.first();
	if (taken) return 'conflict';
	const result = await db
		.prepare('UPDATE cache SET name = ?1 WHERE name = ?2 AND deleted_at IS NULL')
		.bind(newName, oldName)
		.run();
	return (result.meta.changes ?? 0) > 0 ? 'renamed' : 'not_found';
}

/** Hard-remove a soft-deleted tombstone so its name can be reused. */
export async function purgeDeletedCache(db: D1Database, name: string): Promise<void> {
	await db.batch(
		[
			'DELETE FROM object_ref WHERE object_id IN (SELECT o.id FROM object o ' +
				'JOIN cache c ON c.id = o.cache_id WHERE c.name = ?1 AND c.deleted_at IS NOT NULL)',
			'DELETE FROM gc_root WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
			'DELETE FROM pin WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
			'DELETE FROM cache_upstream WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
			'DELETE FROM object WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
			'DELETE FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL'
		].map((sql) => db.prepare(sql).bind(name))
	);
}

export interface DeviceAuthRow {
	device_code: string;
	user_code: string;
	status: string;
	token: string | null;
	expires_at: number;
}

export async function createDeviceAuth(
	db: D1Database,
	deviceCode: string,
	userCode: string,
	expiresAt: number
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO device_auth (device_code, user_code, status, created_at, expires_at) VALUES (?1, ?2, 'pending', ?3, ?4)"
		)
		.bind(deviceCode, userCode, Math.floor(Date.now() / 1000), expiresAt)
		.run();
}

export async function findDeviceAuth(
	db: D1Database,
	deviceCode: string
): Promise<DeviceAuthRow | null> {
	return dbFirst<DeviceAuthRow>(
		db
			.prepare(
				'SELECT device_code, user_code, status, token, expires_at FROM device_auth WHERE device_code = ?1'
			)
			.bind(deviceCode)
	);
}

export async function deleteDeviceAuth(db: D1Database, deviceCode: string): Promise<void> {
	await db.prepare('DELETE FROM device_auth WHERE device_code = ?1').bind(deviceCode).run();
}

// --- root proxy resolution ---------------------------------------------------

export interface LiveCacheRow {
	/** Row id, not just the name: it is what the private-NAR store path is
	 * keyed by (narStoreUrl in store.ts), and unlike the name it is never
	 * reused. */
	id: number;
	name: string;
	priority: number;
	is_public: number;
}

/** Live caches holding an object with this store-path hash. */
export async function cachesWithStorePathHash(
	db: D1Database,
	storePathHash: string
): Promise<LiveCacheRow[]> {
	const { results } = await dbAll<LiveCacheRow>(
		db
			.prepare(
				`SELECT c.id, c.name, c.priority, c.is_public FROM object o
				 JOIN cache c ON c.id = o.cache_id
				 WHERE o.store_path_hash = ?1 AND c.deleted_at IS NULL`
			)
			.bind(storePathHash)
	);
	return results;
}

/** Live caches referencing a NAR by hash (raw or sha256:-prefixed). */
export async function cachesWithNarHash(
	db: D1Database,
	narHashes: string[]
): Promise<LiveCacheRow[]> {
	const placeholders = narHashes.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await dbAll<LiveCacheRow>(
		db
			.prepare(
				`SELECT DISTINCT c.id, c.name, c.priority, c.is_public FROM nar n
				 JOIN object o ON o.nar_id = n.id
				 JOIN cache c ON c.id = o.cache_id
				 WHERE n.nar_hash IN (${placeholders}) AND c.deleted_at IS NULL`
			)
			.bind(...narHashes)
	);
	return results;
}

function nowRfc3339(): string {
	return new Date().toISOString();
}

function requireRowId(result: { meta: { last_row_id?: number } }, what: string): number {
	const id = result.meta.last_row_id;
	if (id === undefined || id === null) throw new Error(`No row id returned inserting ${what}`);
	return id;
}
