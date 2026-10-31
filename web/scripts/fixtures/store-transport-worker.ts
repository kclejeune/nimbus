// Native stream fixture for scripts/test-store-transport.mjs. No real bindings.
import { readViaStore } from '../../src/lib/server/cache/store-transport';
import { readAll, type ExecutionContext } from '../../src/lib/server/cache/platform';

let timers = 0;
let batchReads = 0;
let readConfig: { min: number; capacity: number } | undefined;
let cancelled = false;
let headersSeen: unknown;
let diagnostic: Record<string, unknown> | undefined;
const errorLog = console.error;
console.error = (entry, ...args) => {
	try {
		const event = JSON.parse(entry);
		if (event.event === 'nimbus.store_transport') diagnostic = event;
	} catch {
		/* Runtime errors need not be JSON. */
	}
	errorLog(entry, ...args);
};
const activeTimers = new Set<ReturnType<typeof setTimeout>>();
const timeout = globalThis.setTimeout;
const clear = globalThis.clearTimeout;
globalThis.setTimeout = ((fn, ms, ...args) => {
	timers++;
	const id = timeout(() => {
		activeTimers.delete(id);
		fn(...args);
	}, ms);
	activeTimers.add(id);
	return id;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id) => {
	activeTimers.delete(id);
	clear(id);
}) as typeof clearTimeout;

const prototype = ReadableStreamBYOBReader.prototype as ReadableStreamBYOBReader & {
	readAtLeast(min: number, view: Uint8Array): Promise<ReadableStreamReadResult<Uint8Array>>;
};
const readAtLeast = prototype.readAtLeast;
prototype.readAtLeast = function (min, view) {
	batchReads++;
	readConfig = { min, capacity: view.byteLength };
	return readAtLeast.call(this, min, view);
};

export default {
	async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === '/stats')
			return Response.json({
				timers,
				batchReads,
				readConfig,
				activeTimers: activeTimers.size,
				cancelled,
				headersSeen,
				diagnostic
			});
		timers = batchReads = 0;
		readConfig = undefined;
		cancelled = false;
		headersSeen = undefined;
		diagnostic = undefined;
		const size = Number(url.searchParams.get('size'));
		const mode = url.searchParams.get('mode');
		const sourceSize = mode === 'truncated' ? size - 1 : size;
		const { readable, writable } = new FixedLengthStream(sourceSize);
		const writer = writable.getWriter();
		void writer.closed.catch(() => {
			cancelled = true;
		});
		ctx.waitUntil(
			(async () => {
				try {
					const fragment = new Uint8Array(4096).fill(42);
					for (let offset = 0; offset < sourceSize; offset += fragment.length) {
						if (offset === 65536 && mode === 'error')
							throw new Error('fixture source disconnected');
						if (offset === 65536 && mode === 'stall') {
							await new Promise<void>((resolve) => {
								const id = timeout(resolve, 60_000);
								void writer.closed.catch(() => {
									clear(id);
									resolve();
								});
							});
						}
						await writer.write(
							fragment.subarray(0, Math.min(fragment.length, sourceSize - offset))
						);
					}
					await writer.close();
				} catch (error) {
					await writer.abort(error).catch(() => {});
				}
			})()
		);
		if (mode?.startsWith('collect')) {
			const hint = Number(url.searchParams.get('hint') ?? size);
			const limit = Number(url.searchParams.get('limit') ?? size + 10);
			const bytes = await readAll(readable, limit, hint, { batch: mode !== 'collect-plain' });
			return bytes ? new Response(bytes) : new Response('oversized', { status: 413 });
		}
		const headers = new Headers({ 'Content-Length': String(size) });
		if (mode === 'range') headers.set('Content-Range', `bytes 0-${size - 1}/${size + 1}`);
		const response = new Response(readable, { status: mode === 'range' ? 206 : 200, headers });
		if (mode === 'native') return response;
		const guarded = await readViaStore(
			{
				exports: {
					CachedStore: {
						fetch: async (r: Request) => {
							r.signal.addEventListener(
								'abort',
								() => {
									cancelled = true;
									void writer.abort(r.signal.reason).catch(() => {});
								},
								{ once: true }
							);
							return response;
						}
					}
				}
			} as unknown as ExecutionContext,
			request,
			async () => {
				throw new Error('unexpected uncached fallback');
			}
		);
		headersSeen = Object.fromEntries(guarded.headers);
		return guarded;
	}
};
