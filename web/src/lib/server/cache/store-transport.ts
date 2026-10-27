import { AdmissionError } from './admission';
import { countLoopbackFallback } from './latency';
import { withinMs, type ExecutionContext } from './platform';

// Leave room for upstream probes' five-second timeout and normal backend
// work, but bound the 60–70 s caching-pipeline stalls seen in production.
// Only one uncached attempt follows, with normal backend admission intact.
export const STORE_HEADER_TIMEOUT_MS = 10_000;
export const STORE_BODY_IDLE_TIMEOUT_MS = 15_000;
const BODY_READ_BYTES = 64 * 1024;
const BODY_READ_BUFFER_BYTES = 128 * 1024;
type BatchReader = ReadableStreamBYOBReader & {
	readAtLeast(min: number, view: Uint8Array): Promise<ReadableStreamReadResult<Uint8Array>>;
};

/** Cleanup must not make the fallback wait for the same broken transport. */
export function cancelStoreBody(response: Response | undefined): void {
	void response?.body?.cancel().catch(() => {});
}

function diagnostic(request: Request, phase: string, details: Record<string, unknown>): void {
	const log = phase === 'body' ? console.error : console.warn;
	log(
		JSON.stringify({
			event: 'nimbus.store_transport',
			path: new URL(request.url).pathname,
			phase,
			...details
		})
	);
}

/** Bound source reads, never time spent waiting on downstream backpressure.
 * Large native bodies fill at least 64 KiB into a 128 KiB buffer: available
 * bytes above the minimum save callbacks without waiting for the full buffer.
 * Fifteen seconds to meet the minimum is the progress floor for the internal
 * store transport, independent of the client's download speed. EOF flushes
 * a short final batch. Small bodies and non-native streams read normally.
 * Once bytes have escaped, aborting the transfer lets Nix retry safely; a
 * second representation must never be spliced onto a partial compressed NAR.
 * This cannot detect a stall between Cloudflare's edge and the client after
 * the Worker has already handed over all bytes.
 */
function guardBody(response: Response, request: Request, abort: AbortController): Response {
	if (!response.body) return response;
	const length = response.headers.get('Content-Length');
	const expected =
		length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))
			? Number(length)
			: null;
	let batch: BatchReader | undefined;
	if (expected !== null && expected >= BODY_READ_BYTES) {
		try {
			const byob = response.body.getReader({ mode: 'byob' }) as BatchReader;
			if (typeof byob.readAtLeast === 'function') batch = byob;
			else byob.releaseLock();
		} catch {
			// Ordinary JS streams (including Node fixtures) are not byte streams.
		}
	}
	const reader = batch ?? response.body.getReader();
	const started = performance.now();
	let finished = false;
	let bytes = 0;
	let reads = 0;
	let readMs = 0;
	let maxReadMs = 0;
	let maxDownstreamMs = 0;
	let lastReadAt = started;
	let readingSince: number | undefined;
	let bodyPhase: 'read' | 'downstream' | 'eof' = 'downstream';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const details = () => ({
		bytes,
		expectedBytes: length,
		edge: response.headers.get('CF-Cache-Status'),
		ms: performance.now() - started,
		reads,
		batchBytes: batch ? BODY_READ_BYTES : 0,
		bufferBytes: batch ? BODY_READ_BUFFER_BYTES : 0,
		readMs,
		maxReadMs,
		maxDownstreamMs,
		bodyPhase,
		pendingReadMs: readingSince === undefined ? 0 : performance.now() - readingSince
	});
	const logBody = (status: 'ok' | 'cancelled') => {
		if (bytes < 64 * 1024 * 1024 && (expected ?? 0) < 64 * 1024 * 1024) return;
		console.log(
			JSON.stringify({
				event: 'nimbus.body',
				status,
				path: new URL(request.url).pathname,
				...details()
			})
		);
	};
	const finish = () => {
		finished = true;
		clearTimeout(timer);
		request.signal.removeEventListener('abort', aborted);
	};
	const stop = (reason: unknown) => {
		if (finished) return;
		finish();
		// Cancel the invocation as well as the body: a broken stream transport
		// may never finish its cancellation handshake. Neither cleanup may hold
		// the reader lock or delay the caller's failure.
		abort.abort(reason);
		void reader.cancel(reason).catch(() => {});
		reader.releaseLock();
	};
	const cancel = (reason: unknown) => {
		if (finished) return;
		logBody('cancelled');
		stop(reason);
	};
	const fail = (error: unknown, reason = 'body_error') => {
		if (finished) return;
		diagnostic(request, 'body', {
			...details(),
			reason,
			error: error instanceof Error ? error.message : String(error)
		});
		controller.error(error);
		stop(error);
	};
	const aborted = () => {
		if (finished) return;
		controller.error(request.signal.reason);
		cancel(request.signal.reason);
	};
	// One watchdog follows the pending read. Updating a timestamp is much
	// cheaper than creating and clearing a timer plus Promise.race for every
	// network fragment. A pending downstream pull/write never counts as idle.
	const checkIdle = () => {
		timer = undefined;
		if (finished || readingSince === undefined) return;
		const remaining = STORE_BODY_IDLE_TIMEOUT_MS - (performance.now() - readingSince);
		if (remaining > 0) timer = setTimeout(checkIdle, remaining);
		else fail(new AdmissionError('Cached response body stalled; retry shortly', 2), 'body_timeout');
	};
	const source = {
		start(c: typeof controller) {
			controller = c;
			request.signal.addEventListener('abort', aborted, { once: true });
			if (request.signal.aborted) aborted();
		},
		async pull() {
			if (finished) return;
			try {
				const now = performance.now();
				maxDownstreamMs = Math.max(maxDownstreamMs, now - lastReadAt);
				readingSince = now;
				bodyPhase = 'read';
				if (timer === undefined) timer = setTimeout(checkIdle, STORE_BODY_IDLE_TIMEOUT_MS);
				// read() often yields tiny network fragments even with a large
				// BYOB buffer. Let the native reader assemble a bounded batch,
				// avoiding a JS continuation and forwarding copy per fragment.
				const next = batch
					? await batch.readAtLeast(BODY_READ_BYTES, new Uint8Array(BODY_READ_BUFFER_BYTES))
					: await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
				const ended = performance.now();
				const elapsed = ended - now;
				readMs += elapsed;
				maxReadMs = Math.max(maxReadMs, elapsed);
				lastReadAt = ended;
				readingSince = undefined;
				bodyPhase = next.done ? 'eof' : 'downstream';
				reads++;
				if (finished) return;
				if (next.done) {
					if (expected !== null && bytes !== expected)
						throw new Error('Cached response body ended before Content-Length');
					finish();
					reader.releaseLock();
					controller.close();
					logBody('ok');
				} else {
					bytes += next.value.byteLength;
					if (expected !== null && bytes > expected)
						throw new Error('Cached response body exceeded Content-Length');
					controller.enqueue(next.value);
				}
			} catch (error) {
				fail(error);
			}
		},
		cancel
	};
	const body = new ReadableStream<Uint8Array>(
		source,
		// No read or timeout starts until a consumer asks for bytes.
		{ highWaterMark: 0 }
	);
	// Workerd strips Content-Length from a JS stream, even when copied from
	// the original response. Preserve wire length and truncated-body detection
	// using the native fixed-length stream (unavailable in the Node tests).
	const FixedLength = (
		globalThis as unknown as {
			FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array>;
		}
	).FixedLengthStream;
	if (FixedLength && expected !== null) {
		const { readable, writable } = new FixedLength(expected);
		void body.pipeTo(writable).catch(() => {});
		return new Response(readable, response);
	}
	return new Response(body, response);
}

/** Gateway-only transport protection. Authorization precedes this call and
 * the direct callback retains normal backend admission and visibility checks.
 */
export async function readViaStore(
	ctx: ExecutionContext | undefined,
	request: Request,
	direct: () => Promise<Response>
): Promise<Response> {
	const store = ctx?.exports?.CachedStore;
	if (!store) return direct();
	const abort = new AbortController();
	const signal = AbortSignal.any([request.signal, abort.signal]);
	const pending = store.fetch(new Request(request, { signal }));
	// Transport exceptions retain the caller's existing recovery policy (the
	// combined narinfo route retries through separate cached metadata/body reads).
	const response = await withinMs(pending, STORE_HEADER_TIMEOUT_MS);
	if (response && response.status !== 502) return guardBody(response, request, abort);
	if (request.signal.aborted) throw request.signal.reason;
	const reason = response ? '502' : 'header_timeout';
	countLoopbackFallback();
	diagnostic(request, 'headers', { reason });
	// Abort is best-effort: a transport that ignores the signal may still
	// produce a response. Dispose that late body without awaiting it or adding
	// a permanently pending waitUntil task to this request.
	abort.abort();
	cancelStoreBody(response);
	if (!response) void pending.then(cancelStoreBody, () => {});
	return direct();
}
