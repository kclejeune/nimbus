import { afterEach, expect, it, vi } from 'vitest';
import { AsyncMemo } from './async-memo';
afterEach(() => vi.useRealTimers());
it('coalesces completed values without sharing a loading promise', async () => {
	vi.useFakeTimers();
	const memo = new AsyncMemo<number>(10000, 10);
	let done!: (n: number) => void;
	const leader = memo.get(
		'a',
		() =>
			new Promise((r) => {
				done = r;
			})
	);
	const load = vi.fn(async () => 2);
	const follower = memo.get('a', load);
	done(1);
	await leader;
	await vi.advanceTimersByTimeAsync(100);
	expect(await follower).toBe(1);
	expect(load).not.toHaveBeenCalled();
});
it('recovers from an abandoned request and rejects its late cache update', async () => {
	vi.useFakeTimers();
	const memo = new AsyncMemo<number>(10000, 10);
	let done!: (n: number) => void;
	const leader = memo.get(
		'a',
		() =>
			new Promise((r) => {
				done = r;
			})
	);
	const follower = memo.get('a', async () => 2);
	await vi.advanceTimersByTimeAsync(2100);
	expect(await follower).toBe(2);
	done(1);
	await leader;
	expect(await memo.get('a', async () => 3)).toBe(2);
});
it('does not repopulate invalidated metadata from a stale request', async () => {
	const memo = new AsyncMemo<number>(10000, 10);
	let done!: (n: number) => void;
	const pending = memo.get(
		'a',
		() =>
			new Promise((r) => {
				done = r;
			})
	);
	memo.clear('a');
	done(1);
	await pending;
	expect(await memo.get('a', async () => 2)).toBe(2);
});
