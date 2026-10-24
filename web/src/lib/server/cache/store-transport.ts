import { AdmissionError } from './admission';
import { countLoopbackFallback } from './latency';
import { withinMs, type ExecutionContext } from './platform';

// Leave room for upstream probes' five-second timeout and normal backend
// work, but bound the 60–70 s caching-pipeline stalls seen in production.
// Only one uncached attempt follows, with normal backend admission intact.
export const STORE_HEADER_TIMEOUT_MS = 10_000;
export const STORE_BODY_IDLE_TIMEOUT_MS = 15_000;

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

/** Time source reads, never time spent waiting on downstream backpressure.
 * Once bytes have escaped, aborting the transfer lets Nix retry safely; a
 * second representation must never be spliced onto a partial compressed NAR.
 * This cannot detect a stall between Cloudflare's edge and the client after
 * the Worker has already handed over all bytes.
 */
function guardBody(response: Response, request: Request): Response {
	if (!response.body) return response;
	const reader = response.body.getReader();
	let finished = false;
	let bytes = 0;
	const cancel = (reason: unknown) => {
		finished = true;
		void reader
			.cancel(reason)
			.catch(() => {})
			.finally(() => reader.releaseLock());
	};
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const next = await withinMs(reader.read(), STORE_BODY_IDLE_TIMEOUT_MS);
					if (finished) return;
					if (!next) {
						throw new AdmissionError('Cached response body stalled; retry shortly', 2);
					}
					if (next.done) {
						finished = true;
						reader.releaseLock();
						controller.close();
					} else {
						bytes += next.value.byteLength;
						controller.enqueue(next.value);
					}
				} catch (error) {
					if (finished) return;
					diagnostic(request, 'body', {
						bytes,
						expectedBytes: response.headers.get('Content-Length'),
						edge: response.headers.get('CF-Cache-Status'),
						error: error instanceof Error ? error.message : String(error)
					});
					controller.error(error);
					cancel(error);
				}
			},
			cancel
		},
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
	const length = response.headers.get('Content-Length');
	if (
		FixedLength &&
		length !== null &&
		/^\d+$/.test(length) &&
		Number.isSafeInteger(Number(length))
	) {
		const { readable, writable } = new FixedLength(Number(length));
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
	if (response && response.status !== 502) return guardBody(response, request);
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
