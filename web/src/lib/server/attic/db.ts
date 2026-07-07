// Read-path queries against the attic tables in D1, mirroring the Rust
// worker's d1.rs so both implementations stay drop-in compatible on the same
// database.

import type { D1Database } from '@cloudflare/workers-types';

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

export interface ObjectWithNar {
	object: ObjectRow;
	nar: NarRow;
}

export async function findObject(
	db: D1Database,
	cacheName: string,
	storePathHash: string
): Promise<ObjectWithNar | null> {
	const row = await db
		.prepare(
			'SELECT o.id, o.store_path_hash, o.store_path, o.refs, o.system, o.deriver, ' +
				'o.sigs, o.ca, ' +
				'n.id AS nar_id, n.state, n.nar_hash, n.nar_size, n.compression, n.num_chunks ' +
				'FROM object o ' +
				'INNER JOIN cache c ON o.cache_id = c.id ' +
				'INNER JOIN nar n ON o.nar_id = n.id ' +
				"WHERE c.name = ?1 AND c.deleted_at IS NULL AND o.store_path_hash = ?2 AND n.state = 'V'"
		)
		.bind(cacheName, storePathHash)
		.first<ObjectRow & NarRow & { nar_id: number }>();
	if (!row) return null;
	return {
		object: {
			id: row.id,
			store_path_hash: row.store_path_hash,
			store_path: row.store_path,
			refs: row.refs,
			system: row.system,
			deriver: row.deriver,
			sigs: row.sigs,
			ca: row.ca
		},
		nar: {
			id: row.nar_id,
			state: row.state,
			nar_hash: row.nar_hash,
			nar_size: row.nar_size,
			compression: row.compression,
			num_chunks: row.num_chunks
		}
	};
}

export async function findNarByHash(db: D1Database, narHash: string): Promise<NarRow | null> {
	return db
		.prepare(
			'SELECT id, state, nar_hash, nar_size, compression, num_chunks ' +
				"FROM nar WHERE nar_hash = ?1 AND state = 'V'"
		)
		.bind(narHash)
		.first<NarRow>();
}

export async function findChunksForNar(db: D1Database, narId: number): Promise<ChunkRow[]> {
	const { results } = await db
		.prepare(
			'SELECT ch.id, ch.state, ch.chunk_hash, ch.chunk_size, ch.file_hash, ' +
				'ch.file_size, ch.compression, ch.remote_file ' +
				'FROM chunk ch INNER JOIN chunkref cr ON cr.chunk_id = ch.id ' +
				'WHERE cr.nar_id = ?1 ORDER BY cr.seq'
		)
		.bind(narId)
		.all<ChunkRow>();
	return results;
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
	const result = await db
		.prepare(
			'INSERT INTO nar (state, nar_hash, nar_size, compression, num_chunks, ' +
				'completeness_hint, holders_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6)'
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

export async function createChunk(db: D1Database, chunk: NewChunk): Promise<number> {
	const result = await db
		.prepare(
			'INSERT INTO chunk (state, chunk_hash, chunk_size, file_hash, file_size, ' +
				'compression, remote_file, remote_file_id, holders_count, created_at) ' +
				'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)'
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
		)
		.run();
	return requireRowId(result, 'chunk');
}

export async function createChunkRef(
	db: D1Database,
	narId: number,
	seq: number,
	chunkId: number,
	chunkHash: string,
	compression: string
): Promise<void> {
	await db
		.prepare(
			'INSERT INTO chunkref (nar_id, seq, chunk_id, chunk_hash, compression) ' +
				'VALUES (?1, ?2, ?3, ?4, ?5)'
		)
		.bind(narId, seq, chunkId, chunkHash, compression)
		.run();
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

export async function createObject(db: D1Database, object: NewObject): Promise<void> {
	await db
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
		)
		.run();
}

export async function updateNarState(db: D1Database, narId: number, state: string): Promise<void> {
	await db.prepare('UPDATE nar SET state = ?1 WHERE id = ?2').bind(state, narId).run();
}

/** Backfill the compressed-file hash of a chunk (chunked-protocol uploads). */
export async function updateChunkFileHash(
	db: D1Database,
	chunkId: number,
	fileHash: string
): Promise<void> {
	await db.prepare('UPDATE chunk SET file_hash = ?1 WHERE id = ?2').bind(fileHash, chunkId).run();
}

/**
 * Optimistic dedup lock: atomically bump holders_count if it still has the
 * value we read. Returns the NAR when the CAS wins, null otherwise.
 */
export async function tryLockNar(db: D1Database, narHash: string): Promise<NarRow | null> {
	const nar = await findNarByHash(db, narHash);
	if (!nar) return null;
	const current = await db
		.prepare('SELECT holders_count FROM nar WHERE id = ?1')
		.bind(nar.id)
		.first<{ holders_count: number }>();
	if (!current) return null;
	const result = await db
		.prepare(
			'UPDATE nar SET holders_count = holders_count + 1 WHERE id = ?1 AND holders_count = ?2'
		)
		.bind(nar.id, current.holders_count)
		.run();
	return (result.meta.changes ?? 0) > 0 ? nar : null;
}

export async function releaseNarLock(db: D1Database, narId: number): Promise<void> {
	await db
		.prepare('UPDATE nar SET holders_count = holders_count - 1 WHERE id = ?1 AND holders_count > 0')
		.bind(narId)
		.run();
}

/**
 * Chunk-level dedup lock, the chunk analog of tryLockNar. Matches on hash AND
 * compression (a chunk stored with a different codec is a different file).
 */
export async function tryLockChunk(
	db: D1Database,
	chunkHash: string,
	compression: string
): Promise<ChunkRow | null> {
	const chunk = await db
		.prepare(
			'SELECT id, state, chunk_hash, chunk_size, file_hash, file_size, compression, remote_file ' +
				"FROM chunk WHERE chunk_hash = ?1 AND compression = ?2 AND state = 'V'"
		)
		.bind(chunkHash, compression)
		.first<ChunkRow>();
	if (!chunk) return null;
	const current = await db
		.prepare('SELECT holders_count FROM chunk WHERE id = ?1')
		.bind(chunk.id)
		.first<{ holders_count: number }>();
	if (!current) return null;
	const result = await db
		.prepare(
			'UPDATE chunk SET holders_count = holders_count + 1 WHERE id = ?1 AND holders_count = ?2'
		)
		.bind(chunk.id, current.holders_count)
		.run();
	return (result.meta.changes ?? 0) > 0 ? chunk : null;
}

export async function releaseChunkLock(db: D1Database, chunkId: number): Promise<void> {
	await db
		.prepare(
			'UPDATE chunk SET holders_count = holders_count - 1 WHERE id = ?1 AND holders_count > 0'
		)
		.bind(chunkId)
		.run();
}

export interface PendingUploadRow {
	token: string;
	cache_id: number;
	cache_name: string;
	r2_upload_id: string;
	r2_key: string;
	storage_key: string;
	nar_info: string;
	expected_nar_size: number;
	compression: string;
	parts_uploaded: number;
	bytes_received: number;
	uploaded_parts: string;
}

export async function createPendingUpload(db: D1Database, u: PendingUploadRow): Promise<void> {
	await db
		.prepare(
			'INSERT INTO pending_upload (token, cache_id, cache_name, r2_upload_id, r2_key, ' +
				'storage_key, nar_info, expected_nar_size, compression, parts_uploaded, ' +
				"bytes_received, uploaded_parts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, '[]', ?10)"
		)
		.bind(
			u.token,
			u.cache_id,
			u.cache_name,
			u.r2_upload_id,
			u.r2_key,
			u.storage_key,
			u.nar_info,
			u.expected_nar_size,
			u.compression,
			nowRfc3339()
		)
		.run();
}

export async function getPendingUpload(
	db: D1Database,
	token: string
): Promise<PendingUploadRow | null> {
	return db.prepare('SELECT * FROM pending_upload WHERE token = ?1').bind(token).first();
}

export async function updatePendingUpload(
	db: D1Database,
	token: string,
	partsUploaded: number,
	bytesReceived: number,
	uploadedParts: string
): Promise<void> {
	await db
		.prepare(
			'UPDATE pending_upload SET parts_uploaded = ?1, bytes_received = ?2, uploaded_parts = ?3 WHERE token = ?4'
		)
		.bind(partsUploaded, bytesReceived, uploadedParts, token)
		.run();
}

export async function deletePendingUpload(db: D1Database, token: string): Promise<void> {
	await db.prepare('DELETE FROM pending_upload WHERE token = ?1').bind(token).run();
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
	for (const sql of [
		'DELETE FROM object_ref WHERE object_id IN (SELECT o.id FROM object o ' +
			'JOIN cache c ON c.id = o.cache_id WHERE c.name = ?1 AND c.deleted_at IS NOT NULL)',
		'DELETE FROM gc_root WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
		'DELETE FROM object WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
		'DELETE FROM pending_upload WHERE cache_id IN (SELECT id FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL)',
		'DELETE FROM cache WHERE name = ?1 AND deleted_at IS NOT NULL'
	]) {
		await db.prepare(sql).bind(name).run();
	}
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

function nowRfc3339(): string {
	return new Date().toISOString();
}

function requireRowId(result: { meta: { last_row_id?: number } }, what: string): number {
	const id = result.meta.last_row_id;
	if (id === undefined || id === null) throw new Error(`No row id returned inserting ${what}`);
	return id;
}
