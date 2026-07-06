// Upload endpoints:
//
//   PUT  /_api/v1/upload-path            raw NAR body (or preamble variant);
//                                        server compresses per cache config
//   POST /_api/v1/upload-path/start      chunked transport for >100MB NARs
//   PUT  /_api/v1/upload-path/chunk      (Workers request-body limit); client
//   POST /_api/v1/upload-path/complete   pre-compresses, stored verbatim
//
// NARs below NAR_CHUNK_THRESHOLD are stored whole (one chunk, compressed in
// one shot). Larger simple uploads are FastCDC-chunked: each content-defined
// chunk dedups against the store or is compressed and stored under its own
// content-addressed key, and downloads stream the chunks back to back. The
// >100MB chunked transport still stores whole NARs — its parts arrive
// pre-compressed, so the server cannot cut content-defined boundaries.

import { FastCdcChunker, NAR_CHUNK_THRESHOLD, chunkBuffer } from './chunking';
import {
	compressBuffer,
	extensionFor,
	uploadCompressionFor,
	type CompressionKind
} from './compression';
import * as db from './db';
import { errorResponse, jsonResponse as json } from './http';

type Env = App.Platform['env'];
type ExecutionContext = App.Platform['ctx'];

const MAX_BUFFERED_SIZE = 15 * 1024 * 1024;
const MAX_PREAMBLE_SIZE = 1024 * 1024;
/** Chunk size handed to clients for the chunked protocol. */
const MAX_CHUNK_SIZE = 50 * 1024 * 1024;

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
async function finalizeChunkedNar(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind,
	records: NarChunkRecord[],
	narSize: number
): Promise<Response> {
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

// --- Chunked protocol (client-side zstd, >100MB NARs) ---

interface StartChunkedRequest {
	nar_info: UploadNarInfo;
	nar_size: number;
}

/** POST /_api/v1/upload-path/start */
export async function handleStartChunked(env: Env, body: StartChunkedRequest): Promise<Response> {
	const info = body.nar_info;
	const cache = await db.findCache(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);

	// No proof of possession here: at /start no bytes have been sent yet, and
	// requiring a full upload on dedup would defeat the protocol's purpose.
	const existing = await db.tryLockNar(env.ATTIC_DB, info.nar_hash);
	if (existing) return finishDeduplicated(env, info, cache.id, existing.id);

	// The chunked protocol transports client-side zstd bytes; they are stored
	// verbatim, so the recorded compression must be zstd regardless of config.
	const storageKey = storageKeyFor(info.nar_hash, 'zstd');
	const multipart = await env.CACHE_BUCKET.createMultipartUpload(storageKey);

	const tokenBytes = new Uint8Array(32);
	crypto.getRandomValues(tokenBytes);
	const token = [...tokenBytes].map((b) => b.toString(16).padStart(2, '0')).join('');

	try {
		await db.createPendingUpload(env.ATTIC_DB, {
			token,
			cache_id: cache.id,
			cache_name: info.cache,
			r2_upload_id: multipart.uploadId,
			r2_key: multipart.key,
			storage_key: storageKey,
			nar_info: JSON.stringify(info),
			expected_nar_size: body.nar_size,
			compression: 'zstd',
			parts_uploaded: 0,
			bytes_received: 0,
			uploaded_parts: '[]'
		});
	} catch (e) {
		await multipart.abort().catch(() => {});
		throw e;
	}

	return json({ upload_token: token, chunk_size: MAX_CHUNK_SIZE });
}

/** PUT /_api/v1/upload-path/chunk — requires push on the upload's cache. */
export async function handleUploadChunk(
	request: Request,
	env: Env,
	canPush: (cacheName: string) => boolean
): Promise<Response> {
	const token = request.headers.get('X-Upload-Token');
	if (!token) return errorResponse(400, 'Missing X-Upload-Token header');
	const partNumber = Number(request.headers.get('X-Part-Number'));
	if (!Number.isInteger(partNumber) || partNumber < 1) {
		return errorResponse(400, 'Missing or invalid X-Part-Number header');
	}

	const upload = await db.getPendingUpload(env.ATTIC_DB, token);
	if (!upload) return errorResponse(404, 'Unknown upload token');
	if (!canPush(upload.cache_name)) return errorResponse(403, 'Permission denied: push');

	if (partNumber !== upload.parts_uploaded + 1) {
		return errorResponse(400, `Expected part ${upload.parts_uploaded + 1}, got ${partNumber}`);
	}

	const data = new Uint8Array(await request.arrayBuffer());
	if (data.length === 0) return errorResponse(400, 'Empty chunk data');

	const multipart = env.CACHE_BUCKET.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id);
	const part = await multipart.uploadPart(partNumber, data as unknown as ArrayBuffer);

	const parts: { partNumber: number; etag: string }[] = JSON.parse(upload.uploaded_parts);
	parts.push(part);
	const bytesReceived = upload.bytes_received + data.length;
	await db.updatePendingUpload(
		env.ATTIC_DB,
		token,
		partNumber,
		bytesReceived,
		JSON.stringify(parts)
	);

	return json({ upload_token: token, parts_uploaded: partNumber, bytes_received: bytesReceived });
}

/** POST /_api/v1/upload-path/complete — requires push on the upload's cache. */
export async function handleCompleteChunked(
	env: Env,
	ctx: ExecutionContext | undefined,
	token: string,
	canPush: (cacheName: string) => boolean
): Promise<Response> {
	const upload = await db.getPendingUpload(env.ATTIC_DB, token);
	if (!upload) return errorResponse(404, 'Unknown upload token');
	if (!canPush(upload.cache_name)) return errorResponse(403, 'Permission denied: push');

	const info: UploadNarInfo = JSON.parse(upload.nar_info);
	const parts: { partNumber: number; etag: string }[] = JSON.parse(upload.uploaded_parts);
	if (upload.parts_uploaded === 0 || parts.length === 0) {
		return errorResponse(400, 'No parts uploaded');
	}

	const multipart = env.CACHE_BUCKET.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id);
	await multipart.complete(parts);

	const head = await env.CACHE_BUCKET.head(upload.storage_key);
	if (!head) return errorResponse(500, 'File not found after upload');

	const d1 = env.ATTIC_DB;
	const narId = await db.createNar(d1, {
		state: 'P',
		nar_hash: info.nar_hash,
		nar_size: upload.expected_nar_size,
		compression: upload.compression,
		num_chunks: 1
	});
	try {
		// file_hash starts null and is backfilled below by re-reading the object
		// off the response's critical path (hashing inline would mean holding the
		// whole multi-hundred-MB body in the request).
		const chunkId = await db.createChunk(d1, {
			state: 'V',
			chunk_hash: info.nar_hash,
			chunk_size: upload.expected_nar_size,
			file_hash: null,
			file_size: head.size,
			compression: upload.compression,
			remote_file: remoteFileJson(upload.storage_key),
			remote_file_id: upload.storage_key
		});
		ctx?.waitUntil(backfillFileHash(env, chunkId, upload.storage_key).catch(() => {}));
		await db.createChunkRef(d1, narId, 0, chunkId, info.nar_hash, upload.compression);
		await db.updateNarState(d1, narId, 'V');
		await db.createObject(d1, {
			cache_id: upload.cache_id,
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
		await env.CACHE_BUCKET.delete(upload.storage_key).catch(() => {});
		await db.updateNarState(d1, narId, 'D').catch(() => {});
		throw e;
	}

	await db.deletePendingUpload(d1, token).catch(() => {});
	return uploadedResult(head.size, 0);
}

/** Hash a stored object and record it as the chunk's compressed-file hash. */
async function backfillFileHash(env: Env, chunkId: number, storageKey: string): Promise<void> {
	const object = await env.CACHE_BUCKET.get(storageKey);
	if (!object) return;
	const hasher = newDigestStream();
	await (object.body as unknown as ReadableStream<Uint8Array>).pipeTo(
		hasher as unknown as WritableStream<Uint8Array>
	);
	const fileHash = toHex(await hasher.digest);
	await db.updateChunkFileHash(env.ATTIC_DB, chunkId, fileHash);
}
