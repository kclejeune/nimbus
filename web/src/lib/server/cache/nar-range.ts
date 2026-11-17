import { errorResponse } from '../attic/http';
import { chunkKey } from './db';
import { loadManifest, chargeBackendRead, internalRequest } from './metadata';
import { newFixedLengthStream, withR2Retry, type ExecutionContext } from './platform';
import { prefetchInOrder } from './prefetch';
import { guardBody } from './store-transport';
import { CACHEABLE_NAR_BYTES } from './platform';

export { CACHEABLE_NAR_BYTES } from './platform';

/** Gateway only, after the normal cache/holder authorization. Workers Caching
 * handles ranges for cacheable representations. Larger no-store bodies need
 * explicit compressed offsets; CachedStore must continue emitting full 200s. */
export async function serveLargeNarRange(
	request: Request,
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	hash: string,
	cacheId?: number
): Promise<Response | undefined> {
	if (request.method !== 'GET' || request.headers.has('If-Range')) return;
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
	// Unsupported/malformed ranges are ignored, as on the normal full path.
	if (!range || (!range[1] && !range[2])) return;
	const found = await loadManifest(env, ctx, hash, cacheId);
	if (!found) return;
	const { nar, chunks } = found;
	if (!chunks.length || chunks.some((c) => c.file_size === null)) return;
	const size = chunks.reduce((n, c) => n + c.file_size!, 0);
	if (!Number.isSafeInteger(size) || size <= CACHEABLE_NAR_BYTES) return;
	if (chunks.length !== nar.num_chunks)
		return errorResponse(503, 'Some chunks of this NAR are missing', 'IncompleteNar');
	const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
	const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
	if (!Number.isSafeInteger(start) || start >= size || end < start)
		return new Response(null, {
			status: 416,
			headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' }
		});
	await chargeBackendRead(
		env,
		internalRequest(env, '/_nar_range', request.headers.get('CF-Connecting-IP'))
	);
	const parts: { key: string; offset: number; length: number; size: number }[] = [];
	let at = 0;
	for (const chunk of chunks) {
		const next = at + chunk.file_size!;
		if (next > start && at <= end) {
			const key = chunkKey(chunk);
			if (!key) return errorResponse(500, 'No key in remote file');
			const offset = Math.max(0, start - at);
			parts.push({
				key,
				offset,
				length: Math.min(next - 1, end) - at - offset + 1,
				size: chunk.file_size!
			});
		}
		at = next;
	}
	const length = end - start + 1;
	const { readable, writable } = newFixedLengthStream(length);
	const abort = new AbortController();
	const signal = AbortSignal.any([request.signal, abort.signal]);
	const started = performance.now();
	let completedBytes = 0;
	const pumping = (async () => {
		for await (const { part, object } of prefetchInOrder(
			parts,
			2,
			async (part) => {
				const object = await withR2Retry(() =>
					env.CACHE_BUCKET.get(part.key, { range: { offset: part.offset, length: part.length } })
				);
				if (!object) throw new Error('Range chunk missing from storage');
				if (signal.aborted || object.size !== part.size) {
					void object.body.cancel().catch(() => {});
					throw signal.reason ?? new Error('Range chunk size changed');
				}
				return { part, object };
			},
			async ({ object }) => {
				void object.body.cancel().catch(() => {});
			},
			ctx ? (p) => ctx.waitUntil(p) : undefined,
			() => abort.abort()
		)) {
			await (object.body as unknown as ReadableStream<Uint8Array>).pipeTo(writable, {
				preventClose: true,
				preventAbort: true,
				signal
			});
			completedBytes += part.length;
		}
		await writable.close();
	})().then(
		() => {
			console.log(
				JSON.stringify({
					event: 'nimbus.range',
					status: 'ok',
					start,
					end,
					size,
					completedBytes,
					ms: performance.now() - started
				})
			);
		},
		async (error) => {
			abort.abort(error);
			console.warn(
				JSON.stringify({
					event: 'nimbus.range',
					status: 'error',
					start,
					end,
					size,
					completedBytes,
					requestAborted: request.signal.aborted,
					error: String(error)
				})
			);
			await writable.abort(error).catch(() => {});
		}
	);
	ctx?.waitUntil(pumping);
	return guardBody(
		new Response(readable, {
			status: 206,
			headers: {
				'Content-Type': 'application/x-nix-nar',
				'Content-Length': String(length),
				'Content-Range': `bytes ${start}-${end}/${size}`,
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'no-store'
			}
		}),
		request,
		abort
	);
}
