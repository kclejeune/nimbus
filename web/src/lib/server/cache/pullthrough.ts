// Pull-through persistence (mode=persist upstreams): when a read miss is
// served from an upstream, ingest the path into the local cache in the
// background so future reads are local, re-signed with the cache's key, and
// immune to the upstream's GC.
//
// Ingestion drives the NATIVE upload pipeline: the compressed NAR is
// downloaded, decompressed, verified against the signed NarHash, and stored
// exactly like a client push — FastCDC-chunked past NAR_CHUNK_THRESHOLD,
// recompressed per the cache's compression config. Paths the pipeline cannot
// take (upstream compression other than zstd/uncompressed — there is no xz
// decoder in the worker — or NARs beyond the in-memory caps) stay
// redirect-tier for reads, and their UNPERSISTABLE verdict makes push
// filtering report them missing so the next client push stores them
// natively.
//
// The whole ingest rides the gateway's waitUntil (roughly 30 s of wall clock
// after the response); a kill mid-pipeline is safe — a P-state nar row is
// reaped after its grace period, stale chunk holds recover after a day, and
// the cooldown memo retries in 5 minutes.
//
// This module may import upload.ts/compression (zstd.wasm): it is reachable
// only from router.ts, which is bundled by wrangler alone — never by Vite
// (see worker-entry.ts).

import { parseNarInfo } from '../attic/narinfo';
import { bytesToHex, sha256HexDigest } from '../attic/nix-base32';
import { initZstd, uploadCompressionFor, zstdDecompress } from './compression';
import * as db from './db';
import {
	findExistingPaths,
	PERSIST_MAX_COMPRESSED_BYTES,
	PERSIST_MAX_NAR_BYTES,
	persistIngestible,
	recordVerdicts,
	VERDICT_UNPERSISTABLE
} from './missing-paths';
import { readAll, type ExecutionContext } from './platform';
import { warmNarinfoAfterUpload } from './store';
import { TtlMemo } from './ttl-memo';
import {
	finishDeduplicated,
	handleBufferedUpload,
	handleStreamingUpload,
	MAX_BUFFERED_SIZE,
	tryLockNarProbed,
	type UploadNarInfo
} from './upload';

type Env = App.Platform['env'];

/** A stalled upstream must not eat the whole waitUntil budget. */
const NAR_FETCH_TIMEOUT_MS = 20_000;

// The persist markers ride edge-cached passthroughs, so every hit re-asks
// until ingestion lands and evicts the entry. This memo collapses the
// re-asks (and concurrent duplicate downloads) within an isolate; entries
// are recorded at ingest start, so a failed or unpersistable attempt retries
// only after the cooldown.
const INGEST_COOLDOWN_MS = 5 * 60 * 1000;
const INGEST_MEMO_MAX_ENTRIES = 10_000;
const recentIngests = new TtlMemo<true>(INGEST_COOLDOWN_MS, INGEST_MEMO_MAX_ENTRIES);

/**
 * Ingest one upstream-served path into `cacheName`. Best-effort and
 * idempotent: failures are logged and the passthrough keeps serving; the next
 * edge revalidation retriggers. Runs under the GATEWAY's ctx.waitUntil (the
 * store's RPC context cannot outlive its session). Only the upstream URL is
 * needed — the narinfo text was already signature-verified by the store.
 */
export async function persistUpstreamPath(
	env: Env,
	ctx: ExecutionContext | undefined,
	origin: string,
	cacheName: string,
	upstreamUrl: string,
	narinfoText: string
): Promise<void> {
	const parsed = parseNarInfo(narinfoText);
	if (!parsed?.url) return;
	const storePathHash = (parsed.storePath.split('/').pop() ?? '').slice(0, 32);
	if (storePathHash.length !== 32) return;

	const memoKey = `${cacheName}:${storePathHash}`;
	if (recentIngests.get(memoKey)) return;
	recentIngests.set(memoKey, true);

	try {
		// The persist marker rode an edge-cached response, so re-check the
		// registry before acting on it: an upstream removed (or re-keyed) since
		// the entry was cached is revoked trust — do not ingest from it.
		const registered = await env.ATTIC_DB.prepare('SELECT id FROM upstream WHERE url = ?1')
			.bind(upstreamUrl)
			.first<{ id: number }>();
		if (!registered) {
			console.warn(`pullthrough: upstream ${upstreamUrl} no longer registered; skipping ingest`);
			return;
		}

		// Ground truth for the push filter: an unpersistable entry is recorded
		// so get-missing-paths stops relying on an ingestion that cannot happen
		// (this also corrects verdicts probed without ingestibility knowledge).
		if (!persistIngestible(parsed)) {
			await recordVerdicts(env.ATTIC_DB, registered.id, [
				{ hash: storePathHash, verdict: VERDICT_UNPERSISTABLE }
			]).catch(() => {});
			return;
		}

		const narHashHex = sha256HexDigest(parsed.narHash);
		if (!narHashHex) {
			console.warn(`pullthrough: unsupported NarHash ${parsed.narHash} for ${storePathHash}`);
			return;
		}
		const compression = parsed.compression ?? 'none';

		const d1 = env.ATTIC_DB;
		// Cheapest check first: on marker re-asks for an already-ingested path
		// this is the only query (the memo absorbs repeats within the isolate).
		if ((await findExistingPaths(d1, cacheName, [storePathHash])).size > 0) return;
		const cache = await db.findCache(d1, cacheName);
		if (!cache) return;

		const info: UploadNarInfo = {
			cache: cacheName,
			store_path_hash: storePathHash,
			store_path: parsed.storePath,
			references: parsed.references,
			system: parsed.system,
			deriver: parsed.deriver,
			// The upstream's sigs ride along for completeness; serving re-signs
			// with the cache keypair and ignores these while a keypair exists.
			sigs: parsed.sigs,
			ca: parsed.ca,
			nar_hash: `sha256:${narHashHex}`,
			source: `pullthrough:${upstreamUrl}`,
			created_by: null
		};

		// Whole-NAR dedup: an existing valid NAR just gains another object row.
		// Unlike client pushes there is no possession to prove — the metadata
		// was signature-verified against the upstream's key, and a fresh ingest
		// below verifies the actual bytes against the signed NarHash.
		const existingNar = await tryLockNarProbed(env, info.nar_hash);
		if (existingNar) {
			await finishDeduplicated(env, info, cache.id, existingNar.id);
			await warmNarinfoAfterUpload(ctx, origin, cache, storePathHash);
			return;
		}

		const res = await fetch(`${upstreamUrl}/${parsed.url}`, {
			signal: AbortSignal.timeout(NAR_FETCH_TIMEOUT_MS)
		});
		if (res.status !== 200 || !res.body) {
			console.warn(`pullthrough: NAR fetch ${upstreamUrl}/${parsed.url} returned ${res.status}`);
			return;
		}
		const downloadCap =
			compression === 'none' ? PERSIST_MAX_NAR_BYTES : PERSIST_MAX_COMPRESSED_BYTES;
		let downloaded: Uint8Array | null = await readAll(res.body, downloadCap);
		if (!downloaded) {
			console.warn(`pullthrough: ${parsed.storePath} exceeded the download cap; skipped`);
			return;
		}
		// Transfer integrity when the narinfo names the compressed file's hash.
		const fileHashHex = parsed.fileHash ? sha256HexDigest(parsed.fileHash) : null;
		if (fileHashHex) {
			const digest = bytesToHex(
				new Uint8Array(await crypto.subtle.digest('SHA-256', downloaded as BufferSource))
			);
			if (digest !== fileHashHex) {
				console.warn(`pullthrough: ${parsed.storePath} FileHash mismatch; skipped`);
				return;
			}
		}

		let raw = downloaded;
		if (compression === 'zstd') {
			await initZstd();
			// The signed NarSize bounds the destination buffer (persistIngestible
			// already capped it), so the WASM heap grows to the expected size
			// instead of the global cap; larger-than-declared content fails the
			// decompress, which is a correct rejection of bytes that contradict
			// the signed narinfo.
			raw = zstdDecompress(downloaded, parsed.narSize);
		}
		// Drop the compressed buffer before the pipeline stages allocate.
		downloaded = null;

		// The native pipeline from here: NarHash verification, FastCDC chunking
		// past the threshold, recompression per cache config, row linking. Large
		// bodies go through the streaming path, whose bounded chunk admission
		// keeps peak memory flat.
		const kind = uploadCompressionFor(cache.compression);
		const response =
			raw.length > MAX_BUFFERED_SIZE
				? await handleStreamingUpload(
						env,
						new Response(raw as unknown as BodyInit).body!,
						info,
						cache.id,
						kind
					)
				: await handleBufferedUpload(env, info, cache.id, kind, raw);
		if (!response.ok) {
			console.warn(`pullthrough: pipeline rejected ${parsed.storePath}: ${await response.text()}`);
			return;
		}

		// Evict the passthrough narinfos (per-cache tag and the root proxy's
		// upstream namespace — both purged by the warm) and cache the re-signed
		// local entry, so clients flip to local serving without waiting out the
		// TTL.
		await warmNarinfoAfterUpload(ctx, origin, cache, storePathHash);
		console.log(
			`pullthrough: persisted ${parsed.storePath} (${raw.length} bytes raw) into ${cacheName}`
		);
	} catch (e) {
		console.warn(`pullthrough: ingest into ${cacheName} from ${upstreamUrl} failed: ${e}`);
	}
}
