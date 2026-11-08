import { afterEach, expect, it, vi } from 'vitest';
import { ReadCoalescer } from './read-coalescer';
import { readViaStore, STORE_HEADER_TIMEOUT_MS } from './store-transport';
import type { ExecutionContext } from './platform';

afterEach(() => vi.useRealTimers());

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

it('shares a multi-second fill with overlapping callers without caching later reads', async () => {
	vi.useFakeTimers();
	const reads = new ReadCoalescer<number[]>();
	const pending = deferred<number[]>();
	const leader = reads.get('path:a', () => pending.promise);
	const load = vi.fn(async () => [2]);
	const follower = reads.get('path:a', load);
	await vi.advanceTimersByTimeAsync(3_500);
	expect(load).not.toHaveBeenCalled();
	pending.resolve([1]);
	expect(await leader).toEqual([1]);
	await vi.advanceTimersByTimeAsync(50);
	expect(await follower).toEqual([1]);
	expect(await reads.get('path:a', load)).toEqual([2]);
	expect(load).toHaveBeenCalledOnce();
});

it('separates keys, and invalidation makes later callers reload', async () => {
	const reads = new ReadCoalescer<string>();
	const old = deferred<string>();
	const pending = reads.get('path:a', () => old.promise);
	expect(await reads.get('nar:a', async () => 'other kind')).toBe('other kind');
	reads.clear('path:a');
	expect(await reads.get('path:a', async () => 'fresh')).toBe('fresh');
	old.resolve('old');
	expect(await pending).toBe('old');
	expect(await reads.get('path:a', async () => 'newest')).toBe('newest');
});

it('allows takeover of an abandoned fill and never publishes its late result', async () => {
	vi.useFakeTimers();
	const reads = new ReadCoalescer<string>();
	const old = deferred<string>();
	const leader = reads.get('path:a', () => old.promise);
	const load = vi.fn(async () => 'replacement');
	const follower = reads.get('path:a', load);
	await vi.advanceTimersByTimeAsync(15_100);
	expect(await follower).toBe('replacement');
	old.resolve('abandoned');
	await leader;
	expect(await reads.get('path:a', async () => 'fresh')).toBe('fresh');
});

it('shares a failed fill with its waiters, then permits an independent retry', async () => {
	vi.useFakeTimers();
	const reads = new ReadCoalescer<string>();
	const pending = deferred<string>();
	const error = new Error('D1 DB is overloaded');
	const leader = reads.get('path:a', async () => {
		await pending.promise;
		throw error;
	});
	const load = vi.fn(async () => 'recovered');
	const follower = reads.get('path:a', load);
	const settled = Promise.allSettled([leader, follower]);
	pending.resolve('ready');
	await vi.advanceTimersByTimeAsync(100);
	expect(await settled).toEqual([
		{ status: 'rejected', reason: error },
		{ status: 'rejected', reason: error }
	]);
	expect(load).not.toHaveBeenCalled();
	expect(await reads.get('path:a', load)).toBe('recovered');
});

it.each(['pending', 'completed'])(
	'preserves a completed fill for its waiter when a newer fill is %s',
	async (replacementState) => {
		vi.useFakeTimers();
		const reads = new ReadCoalescer<string>();
		const first = deferred<string>();
		const leader = reads.get('path:a', () => first.promise);
		const redundantRead = vi.fn(async () => 'redundant');
		const waiter = reads.get('path:a', redundantRead);
		const received = vi.fn();
		void waiter.then(received);
		first.resolve('first fill');
		await leader;
		// No timer has fired: the waiter still holds the first fill's lease.
		const second = deferred<string>();
		const replacement = reads.get('path:a', () => second.promise);
		if (replacementState === 'completed') {
			second.resolve('second fill');
			await replacement;
		}
		await vi.advanceTimersByTimeAsync(50);
		expect(received).toHaveBeenCalledWith('first fill');
		expect(redundantRead).not.toHaveBeenCalled();
		second.resolve('second fill');
		expect(await replacement).toBe('second fill');
		// Neither generation becomes a cache for a caller arriving afterwards.
		expect(await reads.get('path:a', async () => 'fresh read')).toBe('fresh read');
	}
);

it('preserves a failed fill for its waiter when a later successful fill replaces the lease', async () => {
	vi.useFakeTimers();
	const reads = new ReadCoalescer<string>();
	const first = deferred<string>();
	const error = new Error('first fill failed');
	const leader = reads.get('path:a', async () => {
		await first.promise;
		throw error;
	});
	const redundantRead = vi.fn(async () => 'redundant');
	const waiter = reads.get('path:a', redundantRead);
	const outcomes = Promise.allSettled([leader, waiter]);
	first.resolve('ready');
	await expect(leader).rejects.toBe(error);
	expect(await reads.get('path:a', async () => 'recovered')).toBe('recovered');
	await vi.advanceTimersByTimeAsync(50);
	expect(await outcomes).toEqual([
		{ status: 'rejected', reason: error },
		{ status: 'rejected', reason: error }
	]);
	expect(redundantRead).not.toHaveBeenCalled();
});

it('starts a fresh read at loopback timeout even when a leader never settles', async () => {
	vi.useFakeTimers();
	const reads = new ReadCoalescer<string>();
	void reads.get('path:a', () => new Promise<string>(() => {}));
	const fresh = vi.fn(async () => 'fresh origin');
	const received = vi.fn();
	const ctx = {
		exports: { CachedStore: { fetch: () => new Promise<Response>(() => {}) } }
	} as unknown as ExecutionContext;
	const response = readViaStore(
		ctx,
		new Request('https://cache.test/_meta/path/a'),
		async () => new Response(await reads.get('path:a', fresh))
	).then(async (response) => received(await response.text()));
	await vi.advanceTimersByTimeAsync(STORE_HEADER_TIMEOUT_MS - 1);
	expect(fresh).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(fresh).toHaveBeenCalledOnce();
	expect(received).toHaveBeenCalledWith('fresh origin');
	await response;
});

it.each([false, true])(
	'invalidates an existing waiter when the cleared fill is settled=%s',
	async (finished) => {
		vi.useFakeTimers();
		const reads = new ReadCoalescer<string>();
		const old = deferred<string>();
		const leader = reads.get('path:a', () => old.promise);
		const fresh = vi.fn(async () => 'fresh');
		const waiter = reads.get('path:a', fresh);
		if (finished) {
			old.resolve('old');
			await leader;
		}
		reads.clear('path:a');
		old.resolve('old');
		await leader;
		await vi.advanceTimersByTimeAsync(50);
		expect(await waiter).toBe('fresh');
		expect(fresh).toHaveBeenCalledOnce();
	}
);

it('does not disturb another key when a path is invalidated', async () => {
	vi.useFakeTimers();
	const reads = new ReadCoalescer<string>();
	const a = deferred<string>(),
		b = deferred<string>();
	const firstA = reads.get('path:a', () => a.promise);
	const firstB = reads.get('path:b', () => b.promise);
	const reloadA = vi.fn(async () => 'fresh a');
	const reloadB = vi.fn(async () => 'duplicate b');
	const waitingA = reads.get('path:a', reloadA);
	const waitingB = reads.get('path:b', reloadB);
	reads.clear('path:a');
	a.resolve('old a');
	b.resolve('b');
	await Promise.all([firstA, firstB]);
	await vi.advanceTimersByTimeAsync(50);
	expect(await waitingA).toBe('fresh a');
	expect(await waitingB).toBe('b');
	expect(reloadB).not.toHaveBeenCalled();
});
