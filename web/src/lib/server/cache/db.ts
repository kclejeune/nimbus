// Read-path queries against the attic tables in D1, mirroring the Rust
// worker's d1.rs so both implementations stay drop-in compatible on the same
// database.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/** D1 caps bound parameters per statement; IN-lists are windowed to this. */
export const PARAM_BATCH = 99;
/** Statements per db.batch() call; larger sets are split into sequential batches. */
export const STMT_BATCH = 100;

/** Run statements in batches of STMT_BATCH. Only atomic within each batch. */
export async function runBatched(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
	for (let i = 0; i < stmts.length; i += STMT_BATCH) {
		await db.batch(stmts.slice(i, i + STMT_BATCH));
	}
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
	upstream_caches: string;
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
	return db
		.prepare(
			'SELECT id, name, keypair, is_public, store_dir, priority, ' +
				'upstream_cache_key_names, compression, retention_period, ' +
				'retention_max_bytes, upstream_caches ' +
				'FROM cache WHERE name = ?1 AND deleted_at IS NULL'
		)
		.bind(name)
		.first<CacheRow>();
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
	const { results } = await db
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
		.all<
			ObjectRow & {
				nar_id: number;
				nar_state: string;
				nar_hash: string;
				nar_size: number;
				nar_compression: string;
				num_chunks: number;
			} & JoinedChunkColumns
		>();
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
 */
export async function findNarWithChunks(
	db: D1Database,
	narHashes: string[]
): Promise<NarWithChunks | null> {
	const placeholders = narHashes.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			'SELECT n.id AS nar_id, n.state AS nar_state, n.nar_hash, n.nar_size, ' +
				'n.compression AS nar_compression, n.num_chunks, ' +
				CHUNK_JOIN_COLUMNS +
				'FROM nar n ' +
				'LEFT JOIN chunkref cr ON cr.nar_id = n.id ' +
				'LEFT JOIN chunk ch ON ch.id = cr.chunk_id ' +
				`WHERE n.nar_hash IN (${placeholders}) AND n.state = 'V' ` +
				'ORDER BY n.id, cr.seq'
		)
		.bind(...narHashes)
		.all<
			{
				nar_id: number;
				nar_state: string;
				nar_hash: string;
				nar_size: number;
				nar_compression: string;
				num_chunks: number;
			} & JoinedChunkColumns
		>();
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

/** Bump last_accessed_at for LRU retention (best-effort; callers ignore errors). */
export async function touchObject(
	db: D1Database,
	cacheName: string,
	storePathHash: string
): Promise<void> {
	await db
		.prepare(
			'UPDATE object SET last_accessed_at = ?1 WHERE store_path_hash = ?2 ' +
				'AND cache_id = (SELECT id FROM cache WHERE name = ?3)'
		)
		.bind(new Date().toISOString(), storePathHash, cacheName)
		.run();
}

/**
 * Bump last_accessed_at for every object in a cache backed by the NAR with
 * this hash (bare or sha256:-prefixed). NAR URLs carry the nar hash rather
 * than a store path hash, so a download can only be attributed at NAR
 * granularity (like the reference server's touch-on-download semantics).
 * Keyed by hash rather than id so the gateway can touch without resolving the
 * NAR row it no longer needs for serving.
 */
export async function touchObjectsForNarHash(
	db: D1Database,
	cacheName: string,
	narHashRaw: string
): Promise<void> {
	await db
		.prepare(
			'UPDATE object SET last_accessed_at = ?1 ' +
				'WHERE cache_id = (SELECT id FROM cache WHERE name = ?2) ' +
				"AND nar_id IN (SELECT id FROM nar WHERE nar_hash IN (?3, ?4) AND state = 'V')"
		)
		.bind(new Date().toISOString(), cacheName, `sha256:${narHashRaw}`, narHashRaw)
		.run();
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

/** Remove a GC pin; returns false when nothing was pinned. */
export async function removeGcRoot(
	db: D1Database,
	cacheId: number,
	storePathHash: string
): Promise<boolean> {
	const result = await db
		.prepare('DELETE FROM gc_root WHERE cache_id = ?1 AND store_path_hash = ?2')
		.bind(cacheId, storePathHash)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/**
 * Whether an admin-issued token (by jti) has been revoked. Missing rows are
 * not revoked (e.g. bootstrap tokens the admin app never tracked).
 */
export async function isTokenRevoked(db: D1Database, jti: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT revoked_at FROM api_token WHERE id = ?1')
		.bind(jti)
		.first<{ revoked_at: string | null }>();
	return row?.revoked_at != null;
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
	const result = await db
		.prepare(
			'INSERT INTO nar (state, nar_hash, nar_size, compression, num_chunks, ' +
				'completeness_hint, holders_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)'
		)
		.bind(nar.state, nar.nar_hash, nar.nar_size, nar.compression, nar.num_chunks, nowRfc3339())
		.run();
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

/**
 * Insert a chunk row, converging on the existing row when a concurrent upload
 * of the same (chunk_hash, compression) already created one — both describe
 * the same content-addressed R2 object. holders_count starts at 0: newborn
 * rows are protected by the orphan reaper's grace period until a chunkref
 * lands. Statement form for use inside atomic batches.
 */
export function insertChunkStmt(db: D1Database, chunk: NewChunk): D1PreparedStatement {
	return db
		.prepare(
			'INSERT INTO chunk (state, chunk_hash, chunk_size, file_hash, file_size, ' +
				'compression, remote_file, remote_file_id, holders_count, created_at) ' +
				'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9) ' +
				'ON CONFLICT (chunk_hash, compression) DO NOTHING'
		)
		.bind(
			chunk.state,
			chunk.chunk_hash,
			chunk.chunk_size,
			chunk.file_hash,
			chunk.file_size,
			chunk.compression,
			chunk.remote_file,
			chunk.remote_file_id,
			nowRfc3339()
		);
}

/** Insert one chunk row; returns false when an existing row won the conflict. */
export async function insertChunk(db: D1Database, chunk: NewChunk): Promise<boolean> {
	const result = await insertChunkStmt(db, chunk).run();
	return (result.meta.changes ?? 0) > 0;
}

/** Valid chunk row for (hash, compression), without taking a hold. */
export async function findChunk(
	db: D1Database,
	chunkHash: string,
	compression: string
): Promise<ChunkRow | null> {
	return db
		.prepare(
			'SELECT id, state, chunk_hash, chunk_size, file_hash, file_size, compression, remote_file ' +
				"FROM chunk WHERE chunk_hash = ?1 AND compression = ?2 AND state = 'V'"
		)
		.bind(chunkHash, compression)
		.first<ChunkRow>();
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
	cache_id: number;
	nar_id: number;
	store_path_hash: string;
	store_path: string;
	references: string[];
	system: string | null;
	deriver: string | null;
	sigs: string[];
	ca: string | null;
}

export function insertObjectStmt(db: D1Database, object: NewObject): D1PreparedStatement {
	return db
		.prepare(
			'INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, ' +
				'refs, system, deriver, sigs, ca, created_at, created_by) ' +
				'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL) ' +
				'ON CONFLICT (cache_id, store_path_hash) DO UPDATE SET nar_id = excluded.nar_id'
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
			nowRfc3339()
		);
}

export async function createObject(db: D1Database, object: NewObject): Promise<void> {
	await insertObjectStmt(db, object).run();
}

export function updateNarStateStmt(
	db: D1Database,
	narId: number,
	state: string
): D1PreparedStatement {
	return db.prepare('UPDATE nar SET state = ?1 WHERE id = ?2').bind(state, narId);
}

export async function updateNarState(db: D1Database, narId: number, state: string): Promise<void> {
	await updateNarStateStmt(db, narId, state).run();
}

/**
 * Which of the given `sha256:`-prefixed chunk hashes exist as valid chunks
 * under the given compression. Batched IN queries; input order not preserved.
 */
export async function findExistingChunkHashes(
	db: D1Database,
	chunkHashes: string[],
	compression: string
): Promise<Set<string>> {
	const existing = new Set<string>();
	for (let i = 0; i < chunkHashes.length; i += PARAM_BATCH) {
		const batch = chunkHashes.slice(i, i + PARAM_BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		const { results } = await db
			.prepare(
				`SELECT chunk_hash FROM chunk WHERE compression = ?1 AND state = 'V' ` +
					`AND chunk_hash IN (${placeholders})`
			)
			.bind(compression, ...batch)
			.all<{ chunk_hash: string }>();
		for (const row of results) existing.add(row.chunk_hash);
	}
	return existing;
}

/**
 * Dedup hold: atomically bump holders_count on the valid NAR row, returning
 * it, or null when none exists. The orphan reaper skips held rows, so a NAR
 * locked here cannot be reaped between the dedup decision and the object row
 * landing — release with releaseNarLock when done.
 */
export async function tryLockNar(db: D1Database, narHash: string): Promise<NarRow | null> {
	const row = await db
		.prepare(
			'UPDATE nar SET holders_count = holders_count + 1, held_at = ?2 ' +
				"WHERE id = (SELECT id FROM nar WHERE nar_hash = ?1 AND state = 'V' ORDER BY id LIMIT 1) " +
				'RETURNING id, state, nar_hash, nar_size, compression, num_chunks'
		)
		.bind(narHash, nowRfc3339())
		.first<NarRow>();
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
	const row = await tryLockChunkStmt(db, chunkHash, compression).first<ChunkRow>();
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
		const results = await db.batch<ChunkRow>(
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
	return db
		.prepare(
			'SELECT device_code, user_code, status, token, expires_at FROM device_auth WHERE device_code = ?1'
		)
		.bind(deviceCode)
		.first();
}

export async function deleteDeviceAuth(db: D1Database, deviceCode: string): Promise<void> {
	await db.prepare('DELETE FROM device_auth WHERE device_code = ?1').bind(deviceCode).run();
}

// --- root proxy resolution ---------------------------------------------------

export interface LiveCacheRow {
	name: string;
	priority: number;
	is_public: number;
}

export async function listLiveCaches(db: D1Database): Promise<LiveCacheRow[]> {
	const { results } = await db
		.prepare('SELECT name, priority, is_public FROM cache WHERE deleted_at IS NULL')
		.all<LiveCacheRow>();
	return results;
}

/** Names of live caches holding an object with this store-path hash. */
export async function cacheNamesWithStorePathHash(
	db: D1Database,
	storePathHash: string
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT c.name FROM object o
			 JOIN cache c ON c.id = o.cache_id
			 WHERE o.store_path_hash = ?1 AND c.deleted_at IS NULL`
		)
		.bind(storePathHash)
		.all<{ name: string }>();
	return results.map((r) => r.name);
}

/** Names of live caches referencing a NAR by hash (raw or sha256:-prefixed). */
export async function cacheNamesWithNarHash(
	db: D1Database,
	narHashes: string[]
): Promise<string[]> {
	const placeholders = narHashes.map((_, i) => `?${i + 1}`).join(', ');
	const { results } = await db
		.prepare(
			`SELECT DISTINCT c.name FROM nar n
			 JOIN object o ON o.nar_id = n.id
			 JOIN cache c ON c.id = o.cache_id
			 WHERE n.nar_hash IN (${placeholders}) AND c.deleted_at IS NULL`
		)
		.bind(...narHashes)
		.all<{ name: string }>();
	return results.map((r) => r.name);
}

function nowRfc3339(): string {
	return new Date().toISOString();
}

function requireRowId(result: { meta: { last_row_id?: number } }, what: string): number {
	const id = result.meta.last_row_id;
	if (id === undefined || id === null) throw new Error(`No row id returned inserting ${what}`);
	return id;
}
