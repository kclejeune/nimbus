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

import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { errorResponse, jsonResponse as json } from '../attic/http';
import { FastCdcChunker, NAR_CHUNK_THRESHOLD, chunkBuffer } from './chunking';
import {
	compressBuffer,
	extensionFor,
	initZstd,
	uploadCompressionFor,
	zstdDecompress,
	type CompressionKind
} from './compression';
import { findCacheCached } from './cache-lookup';
import * as db from './db';
import { recordPush, recordStoreWrite } from './metrics';
import { bytesToHex } from '../attic/nix-base32';
import { newDigestStream, readAll, type ExecutionContext } from './platform';
import { warmNarinfoAfterUpload } from './store';

type Env = App.Platform['env'];

/** Bodies at or below this are buffered whole; larger ones stream (also the
 * routing threshold for pull-through ingestion). */
export const MAX_BUFFERED_SIZE = 15 * 1024 * 1024;
const MAX_PREAMBLE_SIZE = 1024 * 1024;
/** Upper bound on a single CDC chunk — matches the chunker's MAX_CHUNK. */
const CDC_MAX_CHUNK = 16 * 1024 * 1024;
/**
 * Serving a NAR costs one R2 subrequest per chunk against the invocation's
 * 10,000-subrequest budget (Workers Paid default; raiseable via
 * limits.subrequests); manifests that could never be served are rejected at
 * upload time instead. 2000 chunks ≈ a 16 GB NAR at the ~8 MB chunk target,
 * with 5x subrequest headroom left for the serve's other calls.
 */
const MAX_NAR_CHUNKS = 2000;
/**
 * In-flight processNarChunk tasks per streaming upload. Bounds peak memory:
 * each task can hold a raw chunk (≤16 MiB) plus its compressed output while
 * dedup/PUT round-trips overlap. zstd itself is synchronous and single-
 * threaded, so compression never interleaves.
 */
const STREAM_CONCURRENT_CHUNKS = 3;

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
	/** Provenance, stamped server-side (client-supplied values are overwritten
	 * by the router / pullthrough): 'push' or 'pullthrough:<upstream url>'. */
	source?: string | null;
	/** Pushing token's subject, stamped server-side like `source`. */
	created_by?: string | null;
}

function uploadedResult(fileSize: number | null, fracDeduplicated: number): Response {
	// file_size is omitted (not null) when unknown, like the reference's
	// skip_serializing_if.
	return json({
		kind: fracDeduplicated === 1 ? 'deduplicated' : 'uploaded',
		...(fileSize != null ? { file_size: fileSize } : {}),
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
	return bytesToHex(new Uint8Array(buf));
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

/**
 * Whole-NAR dedup hold with a replica probe first — the canonical
 * probe-before-lock rationale, shared by the chunk probe in processNarChunk
 * and pull-through ingestion: the hold is an UPDATE, so taking it directly
 * costs a primary write-txn even when no valid row exists, which is the
 * common case for new content. Only a probe hit takes the (authoritative)
 * lock. A stale replica miss just means redundant fresh-path work that the
 * content-addressed design already converges (here a duplicate nar row,
 * which concurrent pushes of the same NAR could always produce and the
 * orphan reaper tolerates; a row young enough to be missing from a replica
 * is inside the reaper's grace period). A probe hit whose row vanished
 * before the lock (GC race) comes back null and falls through to fresh.
 */
export async function tryLockNarProbed(env: Env, narHash: string): Promise<db.NarRow | null> {
	const probed = await db.findValidNar(db.readSession(env.ATTIC_DB), narHash);
	return probed ? db.tryLockNar(env.ATTIC_DB, narHash) : null;
}

/** Create an object row pointing at an existing NAR (dedup hit). Also used
 * by pull-through ingestion (pullthrough.ts). */
export async function finishDeduplicated(
	env: Env,
	info: UploadNarInfo,
	cacheId: number,
	narId: number
): Promise<Response> {
	try {
		await db.createObject(env.ATTIC_DB, newObjectFrom(info, cacheId, narId));
	} finally {
		await db.releaseNarLock(env.ATTIC_DB, narId).catch(() => {});
	}
	return uploadedResult(null, 1);
}

/** The object row an upload lands, shared by every insert site. */
function newObjectFrom(info: UploadNarInfo, cacheId: number, narId: number): db.NewObject {
	return {
		cache_id: cacheId,
		nar_id: narId,
		store_path_hash: info.store_path_hash,
		store_path: info.store_path,
		references: info.references,
		system: info.system,
		deriver: info.deriver,
		sigs: info.sigs,
		ca: info.ca,
		source: info.source ?? 'push',
		created_by: info.created_by ?? null
	};
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

	// Same probe-before-lock as tryLockNarProbed (which owns the rationale);
	// a stale replica miss re-stores content-addressed bytes that the
	// (chunk_hash, compression) unique index converges.
	const probed = await db.findChunk(db.readSession(env.ATTIC_DB), `sha256:${hash}`, kind);
	const existing = probed ? await db.tryLockChunk(env.ATTIC_DB, `sha256:${hash}`, kind) : null;
	if (existing) {
		recordStoreWrite(env, { deduplicated: true, fileBytes: existing.file_size ?? 0 });
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
	recordStoreWrite(env, { deduplicated: false, fileBytes: compressed.fileSize ?? 0 });
	return {
		locked: false,
		hash,
		size: raw.length,
		fileHash: compressed.fileHash,
		fileSize: compressed.fileSize,
		key
	};
}

/**
 * nar + chunk + chunkref + object rows for a CDC-chunked NAR, in batched
 * statements instead of per-row round-trips. Chunk inserts converge on the
 * winner under the (chunk_hash, compression) unique index, and each chunkref
 * links by hash, so a concurrent upload of the same chunk is adopted without
 * a race window: adopted rows are held (the reaper skips them) and fresh rows
 * are created in the same or an earlier batch than the chunkref that
 * references them.
 */
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
		const stmts: D1PreparedStatement[] = [];
		for (const record of records) {
			if (record.chunkId === undefined) {
				stmts.push(
					db.insertChunkStmt(d1, {
						state: 'V',
						chunk_hash: `sha256:${record.hash}`,
						chunk_size: record.size,
						file_hash: record.fileHash,
						file_size: record.fileSize,
						compression: kind,
						remote_file: remoteFileJson(record.key!),
						remote_file_id: record.key!
					})
				);
			}
		}
		for (const [seq, record] of records.entries()) {
			stmts.push(
				db.insertChunkRefStmt(d1, narId, seq, record.chunkId ?? null, `sha256:${record.hash}`, kind)
			);
		}
		stmts.push(db.updateNarStateStmt(d1, narId, 'V'));
		stmts.push(db.insertObjectStmt(d1, newObjectFrom(info, cacheId, narId)));
		await db.runBatched(d1, stmts);
	} catch (e) {
		// Freshly stored R2 objects are content-addressed and adopted by any
		// retry, so only the DB rows are rolled back here (the orphan reaper
		// clears whatever landed before the failure).
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
	const ids = records
		.filter((r) => r.locked && r.chunkId !== undefined)
		.map((r) => r.chunkId as number);
	await db.releaseChunkLocksById(env.ATTIC_DB, ids).catch(() => {});
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
		await db.runBatched(d1, [
			db.insertChunkStmt(d1, {
				state: 'V',
				chunk_hash: info.nar_hash,
				chunk_size: opts.narSize,
				file_hash: opts.fileHash,
				file_size: opts.fileSize,
				compression: opts.compression,
				remote_file: remoteFileJson(opts.storageKey),
				remote_file_id: opts.storageKey
			}),
			db.insertChunkRefStmt(d1, narId, 0, null, info.nar_hash, opts.compression),
			db.updateNarStateStmt(d1, narId, 'V'),
			db.insertObjectStmt(d1, newObjectFrom(info, cacheId, narId))
		]);
	} catch (e) {
		await db.updateNarState(d1, narId, 'D').catch(() => {});
		// The stored object is content-addressed: a racing identical upload may
		// have adopted the key, so only delete it when no chunk row claims it.
		if (!(await db.findChunk(d1, info.nar_hash, opts.compression).catch(() => null))) {
			await env.CACHE_BUCKET.delete(opts.storageKey).catch(() => {});
		}
		throw e;
	}
	return uploadedResult(opts.fileSize, 0);
}

/**
 * Split the leading `size` bytes off a stream without buffering the rest:
 * returns the head plus a stream of everything after it, or null when the
 * body ends early.
 */
async function splitStream(
	body: ReadableStream<Uint8Array>,
	size: number
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> } | null> {
	const reader = body.getReader();
	const head = new Uint8Array(size);
	let got = 0;
	let leftover: Uint8Array | null = null;
	while (got < size) {
		const { done, value } = await reader.read();
		if (done) return null;
		if (!value || value.length === 0) continue;
		const take = Math.min(size - got, value.length);
		head.set(value.subarray(0, take), got);
		got += take;
		if (take < value.length) leftover = value.subarray(take);
	}
	const rest = new ReadableStream<Uint8Array>({
		start(controller) {
			if (leftover) controller.enqueue(leftover);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return { head, rest };
}

/** PUT /_api/v1/upload-path */
export async function handleUploadPath(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	canPush: (cacheName: string) => boolean,
	tokenSub: string | null = null
): Promise<Response> {
	// NAR info comes from a header, or as a JSON preamble before the NAR bytes.
	// Either way the NAR itself stays a stream; nothing is buffered until the
	// size-based branch below decides to.
	let info: UploadNarInfo | null = null;
	let narBody: ReadableStream<Uint8Array> | null = request.body;
	// Bytes of NAR expected, when the client declared a length; null means
	// unknown (chunked transfer encoding) and forces the streaming path.
	let narLength: number | null = null;
	const contentLengthRaw = request.headers.get('content-length');
	if (contentLengthRaw != null && /^\d+$/.test(contentLengthRaw)) {
		narLength = Number(contentLengthRaw);
	}

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
		if (!request.body) return errorResponse(400, 'Missing request body');
		const split = await splitStream(request.body, preambleSize);
		if (!split) return errorResponse(400, 'Body shorter than preamble');
		try {
			info = JSON.parse(new TextDecoder().decode(split.head));
		} catch (e) {
			return errorResponse(400, `Invalid NAR info preamble: ${e}`);
		}
		narBody = split.rest;
		if (narLength != null) narLength = Math.max(0, narLength - preambleSize);
	}
	if (!info) return errorResponse(400, 'Missing NAR info');
	if (!canPush(info.cache)) return errorResponse(403, 'Permission denied: push');
	// Provenance is stamped server-side; whatever the client sent is ignored.
	info.source = 'push';
	info.created_by = tokenSub;

	// Memoized replica read, like the serve path: push bursts otherwise re-read
	// the row from the primary once per pushed path, and staleness only delays
	// a create-then-push or affects tolerant fields (compression choice).
	const cache = await findCacheCached(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);

	let response: Response;
	// Dedup: an existing valid NAR with this hash just gains another object —
	// after the client proves possession by streaming the claimed bytes.
	const existing = await tryLockNarProbed(env, info.nar_hash);
	if (existing) {
		const denied = await verifyPossession(narBody, info.nar_hash);
		if (denied) {
			await db.releaseNarLock(env.ATTIC_DB, existing.id).catch(() => {});
			return denied;
		}
		response = await finishDeduplicated(env, info, cache.id, existing.id);
	} else {
		const kind = uploadCompressionFor(cache.compression);
		if (!narBody) return errorResponse(400, 'Missing request body');

		if (narLength != null && narLength <= MAX_BUFFERED_SIZE) {
			const body = await readAll(narBody, MAX_BUFFERED_SIZE);
			if (!body) return errorResponse(400, 'Body exceeds declared Content-Length');
			response = await handleBufferedUpload(env, info, cache.id, kind, body);
		} else {
			response = await handleStreamingUpload(env, narBody, info, cache.id, kind);
		}
	}
	if (response.ok) {
		// narLength is the raw NAR stream on the wire; a dedup push still
		// transfers it (the possession proof), so it holds for both branches.
		recordPush(env, info.cache, { deduplicated: !!existing, narBytes: narLength ?? 0 });
		ctx?.waitUntil(
			warmNarinfoAfterUpload(ctx, new URL(request.url).origin, cache, info.store_path_hash)
		);
	}
	return response;
}

/** Store one in-memory raw NAR through the native pipeline: FastCDC-chunked
 * when >= NAR_CHUNK_THRESHOLD, single recompressed chunk otherwise; the body
 * is verified against info.nar_hash either way. Also the pull-through
 * ingestion entry point for small NARs (pullthrough.ts). */
export async function handleBufferedUpload(
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
		// Buffered bodies are ≤15 MB (at most a handful of chunks; pull-through
		// routes anything larger through handleStreamingUpload), so all of them
		// process concurrently: dedup checks and R2 puts overlap while the
		// synchronous zstd calls serialize themselves on the single thread.
		const settled = await Promise.allSettled(
			chunkBuffer(body).map((raw) => processNarChunk(env, kind, raw))
		);
		const records = settled
			.filter((s): s is PromiseFulfilledResult<NarChunkRecord> => s.status === 'fulfilled')
			.map((s) => s.value);
		const failed = settled.find((s) => s.status === 'rejected');
		if (failed) {
			await releaseChunkLocks(env, records);
			throw failed.reason;
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
	recordStoreWrite(env, { deduplicated: false, fileBytes: result.fileSize ?? 0 });

	return createUploadRows(env, info, cacheId, {
		narSize: result.narSize,
		compression: kind,
		fileHash: result.fileHash,
		fileSize: result.fileSize,
		storageKey
	});
}

/**
 * Streaming upload (>15 MB), also used by pull-through ingestion for large
 * NARs (bounded chunk admission keeps memory flat): FastCDC the incoming
 * NAR, deduplicating each chunk against the store and compressing+storing
 * the fresh ones. The NAR
 * hash is verified before any database row is written; chunks stored before a
 * mismatch is detected are content-addressed and get adopted by a retry (or
 * reaped as orphans).
 */
export async function handleStreamingUpload(
	env: Env,
	body: ReadableStream<Uint8Array>,
	info: UploadNarInfo,
	cacheId: number,
	kind: CompressionKind
): Promise<Response> {
	const narHasher = newDigestStream();
	const narWriter = narHasher.getWriter();
	const chunker = new FastCdcChunker();
	// Chunks process concurrently with reading the body, bounded so at most
	// STREAM_CONCURRENT_CHUNKS raw chunks (≤16 MiB each) plus their compressed
	// outputs are held at once. Admission awaits the oldest pending chunk
	// FIFO-style; rejections are surfaced by the allSettled collection below
	// (the extra catch just marks them handled in the meantime).
	const pending: Promise<NarChunkRecord>[] = [];
	let admitted = 0;
	const admit = async (raw: Uint8Array) => {
		if (pending.length - admitted >= STREAM_CONCURRENT_CHUNKS) {
			await pending[admitted++].catch(() => {});
		}
		const task = processNarChunk(env, kind, raw);
		task.catch(() => {});
		pending.push(task);
	};
	let narSize = 0;

	// Settled promises re-await instantly, so collecting twice is harmless;
	// the flag ensures holds are only released once.
	const collectRecords = async (): Promise<{
		records: NarChunkRecord[];
		failure: unknown | null;
	}> => {
		const settled = await Promise.allSettled(pending);
		return {
			records: settled
				.filter((s): s is PromiseFulfilledResult<NarChunkRecord> => s.status === 'fulfilled')
				.map((s) => s.value),
			failure: settled.find((s) => s.status === 'rejected')?.reason ?? null
		};
	};
	let released = false;
	const releaseAll = async () => {
		if (released) return;
		released = true;
		await releaseChunkLocks(env, (await collectRecords()).records);
	};

	try {
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			narSize += value.length;
			await narWriter.write(value as unknown as BufferSource);
			for (const raw of chunker.push(value)) {
				await admit(raw);
			}
		}
		const rest = chunker.finish();
		if (rest) await admit(rest);

		await narWriter.close();
		const narHash = toHex(await narHasher.digest);

		const { records, failure } = await collectRecords();
		if (failure) throw failure;

		if (narHash !== stripSha256(info.nar_hash)) {
			await releaseAll();
			return errorResponse(
				400,
				`NAR hash mismatch: expected ${stripSha256(info.nar_hash)}, got ${narHash}`
			);
		}
		if (records.length === 0) {
			return errorResponse(400, 'Empty NAR');
		}
		// From here linkChunkedNar owns the holds (its finally releases them).
		released = true;
		return finalizeChunkedNar(env, info, cacheId, kind, records, narSize);
	} catch (e) {
		await releaseAll();
		throw e;
	}
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
	if (body.chunks.length > MAX_NAR_CHUNKS) {
		return errorResponse(
			400,
			`Manifest has ${body.chunks.length} chunks; NARs above ${MAX_NAR_CHUNKS} chunks cannot be served`
		);
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
export async function handleCdcQuery(
	env: Env,
	ctx: ExecutionContext | undefined,
	origin: string,
	body: CdcManifest
): Promise<Response> {
	const denied = validateManifest(body);
	if (denied) return denied;
	const info = body.nar_info;
	const cache = await findCacheCached(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);

	const existing = await tryLockNarProbed(env, info.nar_hash);
	if (existing) {
		const response = await finishDeduplicated(env, info, cache.id, existing.id);
		if (response.ok) recordPush(env, info.cache, { deduplicated: true, narBytes: body.nar_size });
		ctx?.waitUntil(warmNarinfoAfterUpload(ctx, origin, cache, info.store_path_hash));
		return response;
	}

	// Replica read: a stale miss only makes the client upload a chunk the
	// server already has, and the chunk PUT dedups that on arrival.
	const unique = [...new Set(body.chunks.map((c) => `sha256:${c.hash}`))];
	const present = await db.findExistingChunkHashes(db.readSession(env.ATTIC_DB), unique, 'zstd');
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

	if (await db.findChunk(db.readSession(env.ATTIC_DB), `sha256:${hash}`, 'zstd')) {
		// Already stored (raced or the client re-sent); nothing to do. If GC
		// reaps it before the complete call, the 409 retry re-uploads it. A
		// stale replica miss just re-stores the same content-addressed bytes,
		// and the insert below converges on the winning row.
		recordStoreWrite(env, { deduplicated: true, fileBytes: compressed.length });
		return json({ ok: true, deduplicated: true });
	}

	const key = chunkStorageKey(hash, 'zstd');
	await env.CACHE_BUCKET.put(key, compressed as unknown as ArrayBuffer);
	recordStoreWrite(env, { deduplicated: false, fileBytes: compressed.length });
	// A concurrent PUT of the same chunk stored the same bytes; whichever row
	// wins the unique index describes them.
	const inserted = await db.insertChunk(env.ATTIC_DB, {
		state: 'V',
		chunk_hash: `sha256:${hash}`,
		chunk_size: raw.length,
		file_hash: toHex(await crypto.subtle.digest('SHA-256', compressed as BufferSource)),
		file_size: compressed.length,
		compression: 'zstd',
		remote_file: remoteFileJson(key),
		remote_file_id: key
	});
	return json({ ok: true, deduplicated: !inserted });
}

/**
 * POST /_api/v1/upload-path/chunks/complete — assemble the NAR from chunk
 * references. Locks every chunk; if any vanished (e.g. GC raced), responds
 * 409 with the missing hashes so the client re-uploads those and retries.
 * The assembled NAR hash is trusted from the client, like the transport this
 * replaced — verifying would mean re-reading and decompressing everything.
 */
export async function handleCdcComplete(
	env: Env,
	ctx: ExecutionContext | undefined,
	origin: string,
	body: CdcManifest
): Promise<Response> {
	const denied = validateManifest(body);
	if (denied) return denied;
	const info = body.nar_info;
	const cache = await findCacheCached(env.ATTIC_DB, info.cache);
	if (!cache) return errorResponse(404, `Cache not found: ${info.cache}`);
	const warm = () =>
		ctx?.waitUntil(warmNarinfoAfterUpload(ctx, origin, cache, info.store_path_hash));

	const existingNar = await tryLockNarProbed(env, info.nar_hash);
	if (existingNar) {
		const response = await finishDeduplicated(env, info, cache.id, existingNar.id);
		if (response.ok) recordPush(env, info.cache, { deduplicated: true, narBytes: body.nar_size });
		warm();
		return response;
	}

	// Lock chunks in one batch round-trip (deduplicating repeats within the
	// NAR: one lock per unique row). No replica probe here, unlike
	// tryLockNarProbed: the client only uploaded the chunks reported missing,
	// so a lock hit is the common case and the probe would be pure overhead.
	const uniqueHashes = [...new Set(body.chunks.map((c) => c.hash))];
	const lockedRows = await db.tryLockChunks(
		env.ATTIC_DB,
		uniqueHashes.map((h) => `sha256:${h}`),
		'zstd'
	);
	const lockedByHash = new Map<string, NarChunkRecord>();
	const records: NarChunkRecord[] = [];
	const missing: string[] = [];
	for (const chunk of body.chunks) {
		let record = lockedByHash.get(chunk.hash);
		if (!record) {
			const row = lockedRows.get(`sha256:${chunk.hash}`);
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

	await linkChunkedNarDeduped(
		env,
		info,
		cache.id,
		records,
		[...lockedByHash.values()],
		body.nar_size
	);
	recordPush(env, info.cache, { deduplicated: false, narBytes: body.nar_size });
	warm();
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
	narSize: number
): Promise<void> {
	const releasable = new Set(uniqueLocked);
	const perRef = records.map((r) => ({ ...r, locked: releasable.delete(r) }));
	await linkChunkedNar(env, info, cacheId, 'zstd', perRef, narSize);
}
