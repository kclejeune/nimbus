// Upload endpoints, ported from the Rust worker's upload_path.rs:
//
//   PUT  /_api/v1/upload-path            raw NAR body (or preamble variant);
//                                        server compresses per cache config
//   POST /_api/v1/upload-path/start      chunked protocol for >100MB NARs;
//   PUT  /_api/v1/upload-path/chunk      client pre-compresses with zstd and
//   POST /_api/v1/upload-path/complete   parts are stored verbatim
//
// Small bodies (≤15MB) are buffered and compressed in one shot; larger ones
// stream through the compressor into an R2 multipart upload in fixed 8MB
// parts, hashing the raw NAR on the way for validation.

import {
	compressBuffer,
	extensionFor,
	makeCompressor,
	PartCollector,
	uploadCompressionFor,
	type CompressionKind
} from './compression';
import * as db from './db';

type Env = App.Platform['env'];

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

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function uploadedResult(fileSize: number | null, fracDeduplicated: number): Response {
	return json({
		kind: fracDeduplicated === 1 ? 'deduplicated' : 'uploaded',
		file_size: fileSize,
		frac_deduplicated: fracDeduplicated
	});
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

	// Dedup: an existing valid NAR with this hash just gains another object.
	const existing = await db.tryLockNar(env.ATTIC_DB, info.nar_hash);
	if (existing) return finishDeduplicated(env, info, cache.id, existing.id);

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

async function handleStreamingUpload(
	env: Env,
	request: Request,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind
): Promise<Response> {
	if (!request.body) return errorResponse(400, 'No request body');

	const storageKey = storageKeyFor(info.nar_hash, kind);
	const multipart = await env.CACHE_BUCKET.createMultipartUpload(storageKey);

	try {
		const narHasher = newDigestStream();
		const narWriter = narHasher.getWriter();
		const fileHasher = newDigestStream();
		const fileWriter = fileHasher.getWriter();

		const compressor = await makeCompressor(kind);
		const collector = new PartCollector();
		const uploadedParts: { partNumber: number; etag: string }[] = [];
		let narSize = 0;
		let fileSize = 0;

		const uploadPart = async (data: Uint8Array) => {
			await fileWriter.write(data as unknown as BufferSource);
			fileSize += data.length;
			uploadedParts.push(
				await multipart.uploadPart(uploadedParts.length + 1, data as unknown as ArrayBuffer)
			);
		};

		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			narSize += value.length;
			await narWriter.write(value as unknown as BufferSource);
			for (const out of await compressor.transform(value)) {
				for (const part of collector.add(out)) await uploadPart(part);
			}
		}
		for (const out of await compressor.finish()) {
			for (const part of collector.add(out)) await uploadPart(part);
		}
		for (const part of collector.flush()) await uploadPart(part);

		await narWriter.close();
		await fileWriter.close();
		const narHash = toHex(await narHasher.digest);
		const fileHash = toHex(await fileHasher.digest);

		if (narHash !== stripSha256(info.nar_hash)) {
			await multipart.abort().catch(() => {});
			return errorResponse(
				400,
				`NAR hash mismatch: expected ${stripSha256(info.nar_hash)}, got ${narHash}`
			);
		}
		if (uploadedParts.length === 0) {
			await multipart.abort().catch(() => {});
			return errorResponse(400, 'Empty NAR');
		}

		await multipart.complete(uploadedParts);

		return createUploadRows(env, info, cacheId, {
			narSize,
			compression: kind,
			fileHash,
			fileSize,
			storageKey
		});
	} catch (e) {
		await multipart.abort().catch(() => {});
		throw e;
	}
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

	// No file hash: computing it would mean re-reading the whole object. The
	// client already validated the NAR hash, which is the integrity check.
	const d1 = env.ATTIC_DB;
	const narId = await db.createNar(d1, {
		state: 'P',
		nar_hash: info.nar_hash,
		nar_size: upload.expected_nar_size,
		compression: upload.compression,
		num_chunks: 1
	});
	try {
		const chunkId = await db.createChunk(d1, {
			state: 'V',
			chunk_hash: info.nar_hash,
			chunk_size: upload.expected_nar_size,
			file_hash: `chunked-${upload.bytes_received}`,
			file_size: head.size,
			compression: upload.compression,
			remote_file: remoteFileJson(upload.storage_key),
			remote_file_id: upload.storage_key
		});
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
