import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdmissionError } from './admission';
import type { ExecutionContext } from './platform';
import {
	readViaStore,
	STORE_BODY_IDLE_TIMEOUT_MS,
	STORE_HEADER_TIMEOUT_MS
} from './store-transport';

const request = () => new Request('https://cache.test/_nar_v2/abc.nar');
const context = (fetch: (request: Request) => Promise<Response>) =>
	({ exports: { CachedStore: { fetch } } }) as unknown as ExecutionContext;

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('abandons stalled cache headers and cleans up a late response without delaying fallback', async () => {
	vi.useFakeTimers();
	let resolve!: (response: Response) => void;
	const pending = new Promise<Response>((r) => (resolve = r));
	let signal!: AbortSignal;
	const ctx = context(async (r) => {
		signal = r.signal;
		return pending;
	});
	const direct = vi.fn(async () => new Response('uncached'));
	const reading = readViaStore(ctx, request(), direct);
	await vi.advanceTimersByTimeAsync(STORE_HEADER_TIMEOUT_MS - 1);
	expect(direct).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(await (await reading).text()).toBe('uncached');
	expect(signal.aborted).toBe(true);
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	resolve(new Response(new ReadableStream({ cancel })));
	await vi.advanceTimersByTimeAsync(0);
	expect(cancel).toHaveBeenCalledOnce();
	expect(direct).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it('recovers from a caching-layer 502 without waiting for broken cleanup', async () => {
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const fetch = async () => new Response(new ReadableStream({ cancel }), { status: 502 });
	const direct = vi.fn(async () => new Response('recovered'));
	expect(await (await readViaStore(context(fetch), request(), direct)).text()).toBe('recovered');
	expect(direct).toHaveBeenCalledOnce();
	expect(cancel).toHaveBeenCalledOnce();
});

it('preserves transport errors for the combined narinfo recovery policy', async () => {
	const direct = vi.fn();
	await expect(
		readViaStore(
			context(async () => {
				throw new Error('Network connection lost');
			}),
			request(),
			direct
		)
	).rejects.toThrow('Network connection lost');
	expect(direct).not.toHaveBeenCalled();
});

it('preserves an explicit backend refusal instead of retrying it', async () => {
	const direct = vi.fn();
	const response = await readViaStore(
		context(
			async () => new Response('budget refused', { status: 503, headers: { 'Retry-After': '60' } })
		),
		request(),
		direct
	);
	expect(response.status).toBe(503);
	expect(response.headers.get('Retry-After')).toBe('60');
	expect(await response.text()).toBe('budget refused');
	expect(direct).not.toHaveBeenCalled();
});

it('bounds an idle partial body, reports its byte offset, and never splices in another response', async () => {
	vi.useFakeTimers();
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const source = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new Uint8Array([1, 2, 3]));
		},
		cancel
	});
	const direct = vi.fn();
	const response = await readViaStore(
		context(
			async () =>
				new Response(source, { headers: { 'Content-Length': '6', 'CF-Cache-Status': 'HIT' } })
		),
		request(),
		direct
	);
	const reader = response.body!.getReader();
	expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
	const failed = expect(reader.read()).rejects.toBeInstanceOf(AdmissionError);
	await vi.advanceTimersByTimeAsync(STORE_BODY_IDLE_TIMEOUT_MS);
	await failed;
	expect(cancel).toHaveBeenCalledOnce();
	expect(direct).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	expect(vi.mocked(console.error).mock.calls.map(([s]) => JSON.parse(s))).toContainEqual(
		expect.objectContaining({
			event: 'nimbus.store_transport',
			phase: 'body',
			bytes: 3,
			expectedBytes: '6',
			edge: 'HIT'
		})
	);
});

it('does not time out a slow downstream consumer, preserves range headers, and clears timers', async () => {
	vi.useFakeTimers();
	const pull = vi.fn((c: ReadableStreamDefaultController<Uint8Array>) => {
		c.enqueue(new Uint8Array([7, 8]));
		c.close();
	});
	const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
	const response = await readViaStore(
		context(
			async () =>
				new Response(source, {
					status: 206,
					headers: { 'Content-Range': 'bytes 0-1/4', 'Content-Length': '2' }
				})
		),
		request(),
		vi.fn()
	);
	await vi.advanceTimersByTimeAsync(STORE_BODY_IDLE_TIMEOUT_MS * 2);
	expect(pull).not.toHaveBeenCalled();
	expect(response.status).toBe(206);
	expect(response.headers.get('Content-Range')).toBe('bytes 0-1/4');
	expect(await response.bytes()).toEqual(new Uint8Array([7, 8]));
	expect(source.locked).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	expect(console.warn).not.toHaveBeenCalled();
});

it('cancels an unused body without starting a source read', async () => {
	const pull = vi.fn();
	const cancel = vi.fn();
	const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
	const response = await readViaStore(
		context(async () => new Response(source)),
		request(),
		vi.fn()
	);
	await response.body!.cancel();
	expect(pull).not.toHaveBeenCalled();
	expect(cancel).toHaveBeenCalledOnce();
});

it('does not retry a caller-aborted fetch', async () => {
	const abort = new AbortController();
	const req = new Request(request(), { signal: abort.signal });
	const direct = vi.fn();
	const reading = readViaStore(
		context(
			(r) =>
				new Promise((_resolve, reject) =>
					r.signal.addEventListener('abort', () => reject(r.signal.reason))
				)
		),
		req,
		direct
	);
	abort.abort(new Error('caller disconnected'));
	await expect(reading).rejects.toThrow('caller disconnected');
	expect(direct).not.toHaveBeenCalled();
});
