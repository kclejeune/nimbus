import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExecutionContext } from './platform';

let metadata: typeof import('./metadata');
let pressure: typeof import('./d1-pressure');
beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	[metadata, pressure] = await Promise.all([import('./metadata'), import('./d1-pressure')]);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function fixture(fetch = vi.fn(async (_r: Request) => new Response('ok'))) {
	const run = vi.fn(async () => ({ meta: {} }));
	const all = vi.fn(async () => ({ results: [{ stale: 1 }], meta: {} }));
	const stmt = { bind: () => stmt, all, run };
	const prepare = vi.fn(() => stmt);
	const env = {
		ATTIC_DB: { prepare },
		CACHE_BASE_URL: 'https://cache.test'
	} as unknown as App.Platform['env'];
	const ctx = { exports: { CachedStore: { fetch } } } as unknown as ExecutionContext;
	return { env, ctx, prepare, all, run, fetch };
}

it('defers gateway and origin touches during explicit overload, then permits recovery', async () => {
	const f = fixture();
	pressure.noteD1Overload(new Error('D1 DB is overloaded'));
	await expect(metadata.touchViaStore(f.env, f.ctx, 1, 'first')).rejects.toThrow('overload');
	await expect(metadata.serveTouch(f.env, 1, 'origin')).rejects.toThrow('overload');
	expect(f.fetch).not.toHaveBeenCalled();
	expect(f.prepare).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(5_000);
	await metadata.touchViaStore(f.env, f.ctx, 1, 'later');
	expect(f.fetch).toHaveBeenCalledOnce();
});

it.each([502, 503])(
	'backs off every touch key after a %i without a direct D1 retry',
	async (status) => {
		const f = fixture(vi.fn(async () => new Response(null, { status })));
		await expect(metadata.touchViaStore(f.env, f.ctx, 1, 'first')).rejects.toThrow();
		await expect(metadata.touchViaStore(f.env, f.ctx, 2, 'different')).rejects.toThrow('deferred');
		expect(f.fetch).toHaveBeenCalledOnce();
		expect(f.prepare).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		f.fetch.mockResolvedValue(new Response('ok'));
		await metadata.touchViaStore(f.env, f.ctx, 2, 'different');
		expect(f.fetch).toHaveBeenCalledTimes(2);
	}
);

it('does not wait for an irrelevant response body cancellation handshake', async () => {
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const f = fixture(vi.fn(async () => new Response(new ReadableStream({ cancel }))));
	await metadata.touchViaStore(f.env, f.ctx, 1, 'body');
	expect(cancel).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it('does not write after a slow retention probe completes following cancellation', async () => {
	const f = fixture();
	let resolve!: (result: Awaited<ReturnType<typeof f.all>>) => void;
	f.all.mockImplementation(() => new Promise((done) => (resolve = done)));
	const abort = new AbortController();
	const result = metadata.serveTouch(
		f.env,
		1,
		'cancelled',
		new Request('https://cache.test', { signal: abort.signal })
	);
	const failed = expect(result).rejects.toThrow('touch abandoned');
	await vi.advanceTimersByTimeAsync(0);
	abort.abort(new Error('touch abandoned'));
	resolve({ results: [{ stale: 1 }], meta: {} });
	await failed;
	expect(f.all).toHaveBeenCalledOnce();
	expect(f.run).not.toHaveBeenCalled();
});

it.each(['expired', 'slow-probe', 'overload-after-probe'])(
	'does not write after a touch becomes %s even without a propagated abort',
	async (mode) => {
		const f = fixture();
		const request = new Request('https://cache.test/_touch/1/hash', {
			headers: { 'X-Nimbus-Touch-Deadline': String(Date.now() + (mode === 'expired' ? -1 : 1000)) }
		});
		if (mode !== 'expired')
			f.all.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, mode === 'slow-probe' ? 1_001 : 500));
				if (mode === 'overload-after-probe')
					pressure.noteD1Overload(new Error('D1 DB is overloaded'));
				return { results: [{ stale: 1 }], meta: {} };
			});
		const failed = expect(metadata.serveTouch(f.env, 1, 'deadline', request)).rejects.toThrow(
			/deadline|overload/
		);
		await vi.advanceTimersByTimeAsync(1_100);
		await failed;
		expect(f.all).toHaveBeenCalledTimes(mode === 'expired' ? 0 : 1);
		expect(f.run).not.toHaveBeenCalled();
		expect(request.signal.aborted).toBe(false);
	}
);

it('still performs a single retention attempt without a store binding', async () => {
	const f = fixture();
	await metadata.touchViaStore(f.env, undefined, 1, 'local');
	expect(f.all).toHaveBeenCalledOnce();
	expect(f.run).toHaveBeenCalledOnce();
});
