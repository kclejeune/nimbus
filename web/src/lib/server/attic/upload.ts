// Upload endpoints:
//
//   PUT  /_api/v1/upload-path                  raw NAR body (or preamble
//                                              variant); server compresses
//   POST /_api/v1/upload-path/chunks           client-side CDC for >100MB
//   PUT  /_api/v1/upload-path/chunks/{hash}    NARs (Workers request-body
//   POST /_api/v1/upload-path/chunks/complete  limit); client cuts + zstds
//
// NARs below NAR_CHUNK_THRESHOLD are stored whole (one chunk, compressed in
// one shot). Larger simple uploads are FastCDC-chunked: each content-defined
// chunk dedups against the store or is compressed and stored under its own
// content-addressed key, and downloads stream the chunks back to back. NARs
// above the Workers request-body limit use the same chunk space: the client
// cuts with a boundary-identical FastCDC, uploads only the chunks the server
// lacks (pre-compressed, stored verbatim), and a stateless complete call
// assembles the NAR from chunk references.

import { FastCdcChunker, NAR_CHUNK_THRESHOLD, chunkBuffer } from './chunking';
import {
	compressBuffer,
	extensionFor,
	initZstd,
	uploadCompressionFor,
	zstdDecompress,
	type CompressionKind
} from './compression';
import * as db from './db';
import { errorResponse, jsonResponse as json } from './http';

type Env = App.Platform['env'];

const MAX_BUFFERED_SIZE = 15 * 1024 * 1024;
const MAX_PREAMBLE_SIZE = 1024 * 1024;
/** Upper bound on a single CDC chunk — matches the chunker's MAX_CHUNK. */
const CDC_MAX_CHUNK = 16 * 1024 * 1024;

const NAR_INFO_HEADER = 'X-Attic-Nar-Info';
const NAR_INFO_PREAMBLE_HEADER = 'X-Attic-Nar-Info-Preamble-Size';

export interface UploadNarInfo {
	cache: string;
	store_path_hash: string;
	store_path: string;
	references: string[];
	system: string | null;
	deriver: string | null;
	sigs: string[];
	ca: string | null;
	nar_hash: string;
}

function uploadedResult(fileSize: number | null, fracDeduplicated: number): Response {
	return json({
		kind: fracDeduplicated === 1 ? 'deduplicated' : 'uploaded',
		file_size: fileSize,
		frac_deduplicated: fracDeduplicated
	});
}

function chunkStorageKey(chunkHashHex: string, kind: CompressionKind): string {
	return `chunk/${chunkHashHex.slice(0, 2)}/${chunkHashHex}${extensionFor(kind)}`;
}

function stripSha256(hash: string): string {
	return hash.startsWith('sha256:') ? hash.slice(7) : hash;
}

function storageKeyFor(narHash: string, kind: CompressionKind): string {
	const hex = stripSha256(narHash);
	return `nar/${hex.slice(0, 2)}/${hex}${extensionFor(kind)}`;
}

function remoteFileJson(key: string): string {
	return JSON.stringify({ bucket: 'cache', key });
}

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** crypto.DigestStream is a Workers-runtime extension absent from DOM types. */
interface DigestStreamLike extends WritableStream<BufferSource> {
	readonly digest: Promise<ArrayBuffer>;
}

function newDigestStream(): DigestStreamLike {
	const workersCrypto = crypto as unknown as {
		DigestStream: new (algorithm: string) => DigestStreamLike;
	};
	return new workersCrypto.DigestStream('SHA-256');
}

/**
 * Proof of possession (reference-server default): a client whose upload
 * dedups must still stream the NAR so we can verify it actually has the
 * bytes, not just the hash. Returns an error Response on mismatch.
 */
async function verifyPossession(
	body: Uint8Array | ReadableStream<Uint8Array> | null,
	narHash: string
): Promise<Response | null> {
	let actual: string;
	if (body == null) {
		return errorResponse(400, 'Missing NAR body (proof of possession required)');
	} else if (body instanceof Uint8Array) {
		actual = toHex(await crypto.subtle.digest('SHA-256', body as BufferSource));
	} else {
		const hasher = newDigestStream();
		await body.pipeTo(hasher as unknown as WritableStream<Uint8Array>);
		actual = toHex(await hasher.digest);
	}
	if (actual !== stripSha256(narHash)) {
		return errorResponse(400, `NAR hash mismatch: expected ${stripSha256(narHash)}, got ${actual}`);
	}
	return null;
}

/** Create an object row pointing at an existing NAR (dedup hit). */
async function finishDeduplicated(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	narId: number
): Promise<Response> {
	try {
		await db.createObject(env.ATTIC_DB, {
			cache_id: cacheId,
			nar_id: narId,
			store_path_hash: info.store_path_hash,
			store_path: info.store_path,
			references: info.references,
			system: info.system,
			deriver: info.deriver,
			sigs: info.sigs,
			ca: info.ca
		});
	} finally {
		await db.releaseNarLock(env.ATTIC_DB, narId).catch(() => {});
	}
	return uploadedResult(null, 1);
}

// --- FastCDC chunked storage (NARs ≥ NAR_CHUNK_THRESHOLD) ---

interface NarChunkRecord {
	/** Set when this chunk deduplicated against an existing row. */
	chunkId?: number;
	/** holders_count was bumped and must be released after linking. */
	locked: boolean;
	/** sha256 hex of the raw (uncompressed) chunk. */
	hash: string;
	size: number;
	fileHash: string | null;
	fileSize: number | null;
	/** R2 key, set for freshly stored chunks. */
	key?: string;
}

/** Dedup one CDC chunk against the store, or compress and upload it. */
async function processNarChunk(
	env: Env,
	kind: CompressionKind,
	raw: Uint8Array
): Promise<NarChunkRecord> {
	const hash = toHex(await crypto.subtle.digest('SHA-256', raw as BufferSource));

	const existing = await db.tryLockChunk(env.ATTIC_DB, `sha256:${hash}`, kind);
	if (existing) {
		return {
			chunkId: existing.id,
			locked: true,
			hash,
			size: raw.length,
			fileHash: existing.file_hash,
			fileSize: existing.file_size
		};
	}

	const compressed = await compressBuffer(raw, kind);
	const key = chunkStorageKey(hash, kind);
	// Content-addressed key: a concurrent upload of the same chunk writes the
	// same bytes, so racing puts are harmless.
	await env.CACHE_BUCKET.put(key, compressed.data as unknown as ArrayBuffer);
	return {
		locked: false,
		hash,
		size: raw.length,
		fileHash: compressed.fileHash,
		fileSize: compressed.fileSize,
		key
	};
}

/** nar + chunk + chunkref + object rows for a CDC-chunked NAR. */
async function linkChunkedNar(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind,
	records: NarChunkRecord[],
	narSize: number
): Promise<void> {
	const d1 = env.ATTIC_DB;
	const narId = await db.createNar(d1, {
		state: 'P',
		nar_hash: info.nar_hash,
		nar_size: narSize,
		compression: kind,
		num_chunks: records.length
	});
	try {
		for (const [seq, record] of records.entries()) {
			let chunkId = record.chunkId;
			if (chunkId === undefined) {
				try {
					chunkId = await db.createChunk(d1, {
						state: 'V',
						chunk_hash: `sha256:${record.hash}`,
						chunk_size: record.size,
						file_hash: record.fileHash,
						file_size: record.fileSize,
						compression: kind,
						remote_file: remoteFileJson(record.key!),
						remote_file_id: record.key!
					});
				} catch (e) {
					// Unique-constraint race: a concurrent upload created the same
					// chunk row between our dedup check and now. Adopt theirs.
					const raced = await db.tryLockChunk(d1, `sha256:${record.hash}`, kind);
					if (!raced) throw e;
					chunkId = raced.id;
					record.locked = true;
				}
				record.chunkId = chunkId;
			}
			await db.createChunkRef(d1, narId, seq, chunkId, `sha256:${record.hash}`, kind);
		}
		await db.updateNarState(d1, narId, 'V');
		await db.createObject(d1, {
			cache_id: cacheId,
			nar_id: narId,
			store_path_hash: info.store_path_hash,
			store_path: info.store_path,
			references: info.references,
			system: info.system,
			deriver: info.deriver,
			sigs: info.sigs,
			ca: info.ca
		});
	} catch (e) {
		// Freshly stored R2 objects are content-addressed and adopted by any
		// retry, so only the DB rows are rolled back here.
		await db.updateNarState(d1, narId, 'D').catch(() => {});
		throw e;
	} finally {
		await releaseChunkLocks(env, records);
	}
}

async function finalizeChunkedNar(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind,
	records: NarChunkRecord[],
	narSize: number
): Promise<Response> {
	await linkChunkedNar(env, info, cacheId, kind, records, narSize);
	const dedupedBytes = records.reduce((sum, r) => sum + (r.key ? 0 : r.size), 0);
	const fileSize = records.every((r) => r.fileSize != null)
		? records.reduce((sum, r) => sum + (r.fileSize ?? 0), 0)
		: null;
	return uploadedResult(fileSize, narSize > 0 ? dedupedBytes / narSize : 0);
}

async function releaseChunkLocks(env: Env, records: NarChunkRecord[]): Promise<void> {
	for (const record of records) {
		if (record.locked && record.chunkId !== undefined) {
			await db.releaseChunkLock(env.ATTIC_DB, record.chunkId).catch(() => {});
		}
	}
}

/** nar + chunk + chunkref + object rows for a freshly stored single-chunk NAR. */
async function createUploadRows(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	opts: {
		narSize: number;
		compression: string;
		fileHash: string | null;
		fileSize: number;
		storageKey: string;
	}
): Promise<Response> {
	const d1 = env.ATTIC_DB;
	const narId = await db.createNar(d1, {
		state: 'P',
		nar_hash: info.nar_hash,
		nar_size: opts.narSize,
		compression: opts.compression,
		num_chunks: 1
	});
	try {
		const chunkId = await db.createChunk(d1, {
			state: 'V',
			chunk_hash: info.nar_hash,
			chunk_size: opts.narSize,
			file_hash: opts.fileHash,
			file_size: opts.fileSize,
			compression: opts.compression,
			remote_file: remoteFileJson(opts.storageKey),
			remote_file_id: opts.storageKey
		});
		await db.createChunkRef(d1, narId, 0, chunkId, info.nar_hash, opts.compression);
		await db.updateNarState(d1, narId, 'V');
		await db.createObject(d1, {
			cache_id: cacheId,
			nar_id: narId,
			store_path_hash: info.store_path_hash,
			store_path: info.store_path,
			references: info.references,
			system: info.system,
			deriver: info.deriver,
			sigs: info.sigs,
			ca: info.ca
		});
	} catch (e) {
		await env.CACHE_BUCKET.delete(opts.storageKey).catch(() => {});
		await db.updateNarState(d1, narId, 'D').catch(() => {});
		throw e;
	}
	return uploadedResult(opts.fileSize, 0);
}

/** PUT /_api/v1/upload-path */
export async function handleUploadPath(
	request: Request,
	env: Env,
	canPush: (cacheName: string) => boolean
): Promise<Response> {
	// NAR info comes from a header, or as a JSON preamble before the NAR bytes.
	let info: UploadNarInfo | null = null;
	let preambleBody: Uint8Array | null = null;

	const headerRaw = request.headers.get(NAR_INFO_HEADER);
	if (headerRaw) {
		try {
			info = JSON.parse(headerRaw);
		} catch (e) {
			return errorResponse(400, `Invalid NAR info: ${e}`);
		}
	} else {
		const preambleSizeRaw = request.headers.get(NAR_INFO_PREAMBLE_HEADER);
		if (!preambleSizeRaw) return errorResponse(400, 'Missing NAR info');
		const preambleSize = Number(preambleSizeRaw);
		if (!Number.isInteger(preambleSize) || preambleSize <= 0 || preambleSize > MAX_PREAMBLE_SIZE) {
			return errorResponse(400, 'Invalid preamble size');
		}
		const body = new Uint8Array(await request.arrayBuffer());
		if (body.length < preambleSize) return errorResponse(400, 'Body shorter than preamble');
		try {
			info = JSON.parse(new TextDecoder().decode(body.subarray(0, preambleSize)));
		} catch (e) {
			return errorResponse(400, `Invalid NAR info preamble: ${e}`);
		}
		preambleBody = body.subarray(preambleSize);
	}
	if (!info) return errorResponse(400, 'Missing NAR info');
	if (!canPush(info.cache)) return errorResponse(403, 'Permission denied: push');

	const cache = await db.findCache(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);

	// Dedup: an existing valid NAR with this hash just gains another object —
	// after the client proves possession by streaming the claimed bytes.
	const existing = await db.tryLockNar(env.ATTIC_DB, info.nar_hash);
	if (existing) {
		const denied = await verifyPossession(preambleBody ?? request.body, info.nar_hash);
		if (denied) {
			await db.releaseNarLock(env.ATTIC_DB, existing.id).catch(() => {});
			return denied;
		}
		return finishDeduplicated(env, info, cache.id, existing.id);
	}

	const kind = uploadCompressionFor(cache.compression);

	if (preambleBody) return handleBufferedUpload(env, info, cache.id, kind, preambleBody);

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_BUFFERED_SIZE) {
		return handleStreamingUpload(env, request, info, cache.id, kind);
	}
	return handleBufferedUpload(
		env,
		info,
		cache.id,
		kind,
		new Uint8Array(await request.arrayBuffer())
	);
}

async function handleBufferedUpload(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind,
	body: Uint8Array
): Promise<Response> {
	if (body.length >= NAR_CHUNK_THRESHOLD) {
		const narHash = toHex(await crypto.subtle.digest('SHA-256', body as BufferSource));
		if (narHash !== stripSha256(info.nar_hash)) {
			return errorResponse(
				400,
				`NAR hash mismatch: expected ${stripSha256(info.nar_hash)}, got ${narHash}`
			);
		}
		const records: NarChunkRecord[] = [];
		try {
			for (const raw of chunkBuffer(body)) {
				records.push(await processNarChunk(env, kind, raw));
			}
		} catch (e) {
			await releaseChunkLocks(env, records);
			throw e;
		}
		return finalizeChunkedNar(env, info, cacheId, kind, records, body.length);
	}

	const result = await compressBuffer(body, kind);

	if (result.narHash !== stripSha256(info.nar_hash)) {
		return errorResponse(
			400,
			`NAR hash mismatch: expected ${stripSha256(info.nar_hash)}, got ${result.narHash}`
		);
	}

	const storageKey = storageKeyFor(info.nar_hash, kind);
	await env.CACHE_BUCKET.put(storageKey, result.data as unknown as ArrayBuffer);

	return createUploadRows(env, info, cacheId, {
		narSize: result.narSize,
		compression: kind,
		fileHash: result.fileHash,
		fileSize: result.fileSize,
		storageKey
	});
}

/**
 * Streaming upload (>15 MB): FastCDC the incoming NAR, deduplicating each
 * chunk against the store and compressing+storing the fresh ones. The NAR
 * hash is verified before any database row is written; chunks stored before a
 * mismatch is detected are content-addressed and get adopted by a retry (or
 * reaped as orphans).
 */
async function handleStreamingUpload(
	env: Env,
	request: Request,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind
): Promise<Response> {
	if (!request.body) return errorResponse(400, 'No request body');

	const narHasher = newDigestStream();
	const narWriter = narHasher.getWriter();
	const chunker = new FastCdcChunker();
	const records: NarChunkRecord[] = [];
	let narSize = 0;

	try {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			narSize += value.length;
			await narWriter.write(value as unknown as BufferSource);
			for (const raw of chunker.push(value)) {
				records.push(await processNarChunk(env, kind, raw));
			}
		}
		const rest = chunker.finish();
		if (rest) records.push(await processNarChunk(env, kind, rest));

		await narWriter.close();
		const narHash = toHex(await narHasher.digest);

		if (narHash !== stripSha256(info.nar_hash)) {
			await releaseChunkLocks(env, records);
			return errorResponse(
				400,
				`NAR hash mismatch: expected ${stripSha256(info.nar_hash)}, got ${narHash}`
			);
		}
		if (records.length === 0) {
			return errorResponse(400, 'Empty NAR');
		}
	} catch (e) {
		await releaseChunkLocks(env, records);
		throw e;
	}

	return finalizeChunkedNar(env, info, cacheId, kind, records, narSize);
}

// --- Client-side CDC protocol (>100MB NARs) ---

export interface CdcManifest {
	nar_info: UploadNarInfo;
	nar_size: number;
	/** Raw sha256 hex + uncompressed size per chunk, in NAR order. */
	chunks: { hash: string; size: number }[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Shared manifest validation; returns an error Response or null. */
function validateManifest(body: CdcManifest): Response | null {
	if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
		return errorResponse(400, 'Manifest has no chunks');
	}
	let total = 0;
	for (const chunk of body.chunks) {
		if (!HEX64.test(chunk.hash ?? '')) return errorResponse(400, `Invalid chunk hash`);
		if (!Number.isInteger(chunk.size) || chunk.size <= 0 || chunk.size > CDC_MAX_CHUNK) {
			return errorResponse(400, `Invalid chunk size: ${chunk.size}`);
		}
		total += chunk.size;
	}
	if (total !== body.nar_size) {
		return errorResponse(400, `Chunk sizes sum to ${total}, expected nar_size ${body.nar_size}`);
	}
	return null;
}

/**
 * POST /_api/v1/upload-path/chunks — which chunks of this NAR the server
 * lacks. Whole-NAR dedup first (no proof of possession possible — no bytes
 * yet); otherwise existence is checked against (chunk_hash, zstd).
 */
export async function handleCdcQuery(env: Env, body: CdcManifest): Promise<Response> {
	const denied = validateManifest(body);
	if (denied) return denied;
	const info = body.nar_info;
	const cache = await db.findCache(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);

	const existing = await db.tryLockNar(env.ATTIC_DB, info.nar_hash);
	if (existing) return finishDeduplicated(env, info, cache.id, existing.id);

	const unique = [...new Set(body.chunks.map((c) => `sha256:${c.hash}`))];
	const present = await db.findExistingChunkHashes(env.ATTIC_DB, unique, 'zstd');
	const missing = unique.filter((h) => !present.has(h)).map((h) => h.slice('sha256:'.length));
	return json({ kind: 'pending', missing_chunk_hashes: missing });
}

/**
 * PUT /_api/v1/upload-path/chunks/{hash} — one zstd-compressed chunk, stored
 * verbatim under its content address. Stateless: the chunk row lands
 * immediately (state V); an abandoned push leaves unreferenced rows that the
 * orphan pass reaps after its grace period.
 */
export async function handleCdcChunkPut(
	request: Request,
	env: Env,
	hash: string
): Promise<Response> {
	if (!HEX64.test(hash)) return errorResponse(400, 'Invalid chunk hash');

	const compressed = new Uint8Array(await request.arrayBuffer());
	if (compressed.length === 0) return errorResponse(400, 'Empty chunk body');

	// Verify by decompressing: raw sha256 must equal the claimed hash, and the
	// bomb guard caps the decompressed size at the chunker's MAX_CHUNK.
	await initZstd();
	let raw: Uint8Array;
	try {
		raw = zstdDecompress(compressed, CDC_MAX_CHUNK);
	} catch (e) {
		return errorResponse(400, `Invalid zstd chunk: ${e}`);
	}
	const actual = toHex(await crypto.subtle.digest('SHA-256', raw as BufferSource));
	if (actual !== hash) {
		return errorResponse(400, `Chunk hash mismatch: expected ${hash}, got ${actual}`);
	}

	if (await db.tryLockChunk(env.ATTIC_DB, `sha256:${hash}`, 'zstd').then(releaseIfLocked(env))) {
		// Already stored (raced or the client re-sent); nothing to do.
		return json({ ok: true, deduplicated: true });
	}

	const key = chunkStorageKey(hash, 'zstd');
	await env.CACHE_BUCKET.put(key, compressed as unknown as ArrayBuffer);
	try {
		await db.createChunk(env.ATTIC_DB, {
			state: 'V',
			chunk_hash: `sha256:${hash}`,
			chunk_size: raw.length,
			file_hash: toHex(await crypto.subtle.digest('SHA-256', compressed as BufferSource)),
			file_size: compressed.length,
			compression: 'zstd',
			remote_file: remoteFileJson(key),
			remote_file_id: key
		});
	} catch (e) {
		// Unique-constraint race: a concurrent upload of the same chunk won the
		// row; theirs describes the bytes its own PUT stored. Adopt it.
		const raced = await db.tryLockChunk(env.ATTIC_DB, `sha256:${hash}`, 'zstd');
		if (!raced) throw e;
		await db.releaseChunkLock(env.ATTIC_DB, raced.id).catch(() => {});
	}
	return json({ ok: true, deduplicated: false });
}

/** Curried helper: release a freshly acquired chunk lock, return whether it existed. */
function releaseIfLocked(env: Env): (chunk: { id: number } | null) => Promise<boolean> {
	return async (chunk) => {
		if (!chunk) return false;
		await db.releaseChunkLock(env.ATTIC_DB, chunk.id).catch(() => {});
		return true;
	};
}

/**
 * POST /_api/v1/upload-path/chunks/complete — assemble the NAR from chunk
 * references. Locks every chunk; if any vanished (e.g. GC raced), responds
 * 409 with the missing hashes so the client re-uploads those and retries.
 * The assembled NAR hash is trusted from the client, like the transport this
 * replaced — verifying would mean re-reading and decompressing everything.
 */
export async function handleCdcComplete(env: Env, body: CdcManifest): Promise<Response> {
	const denied = validateManifest(body);
	if (denied) return denied;
	const info = body.nar_info;
	const cache = await db.findCache(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);

	const existingNar = await db.tryLockNar(env.ATTIC_DB, info.nar_hash);
	if (existingNar) return finishDeduplicated(env, info, cache.id, existingNar.id);

	// Lock chunks (deduplicating repeats within the NAR: one lock per row).
	const lockedByHash = new Map<string, NarChunkRecord>();
	const records: NarChunkRecord[] = [];
	const missing: string[] = [];
	for (const chunk of body.chunks) {
		let record = lockedByHash.get(chunk.hash);
		if (!record) {
			const row = await db.tryLockChunk(env.ATTIC_DB, `sha256:${chunk.hash}`, 'zstd');
			if (!row) {
				if (!missing.includes(chunk.hash)) missing.push(chunk.hash);
				continue;
			}
			record = {
				chunkId: row.id,
				locked: true,
				hash: chunk.hash,
				size: chunk.size,
				fileHash: row.file_hash,
				fileSize: row.file_size
			};
			lockedByHash.set(chunk.hash, record);
		}
		records.push(record);
	}
	if (missing.length > 0) {
		await releaseChunkLocks(env, [...lockedByHash.values()]);
		return json({ missing_chunk_hashes: missing }, 409);
	}

	await linkChunkedNarDeduped(env, info, cache.id, records, [...lockedByHash.values()], body);
	const fileSize = records.every((r) => r.fileSize != null)
		? records.reduce((sum, r) => sum + (r.fileSize ?? 0), 0)
		: null;
	return uploadedResult(fileSize, 0);
}

/**
 * linkChunkedNar writes one chunkref per records entry and releases each
 * lock once per entry — with repeated chunks the same row appears multiple
 * times, so locks (held once per unique row) are released separately.
 */
async function linkChunkedNarDeduped(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	records: NarChunkRecord[],
	uniqueLocked: NarChunkRecord[],
	body: CdcManifest
): Promise<void> {
	const releasable = new Set(uniqueLocked);
	const perRef = records.map((r) => ({ ...r, locked: releasable.delete(r) }));
	await linkChunkedNar(env, info, cacheId, 'zstd', perRef, body.nar_size);
}
