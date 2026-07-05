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
