import { afterEach, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { uiRead, invalidateUiReads } from './ui-read-cache';
const db = () => ({}) as D1Database;
const busy = () => Promise.reject(new Error('D1_ERROR: database is overloaded'));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('caches display reads across fresh loads, isolates bindings, and invalidates after writes', async () => {
	const one = db(),
		two = db(),
		load = vi.fn(async () => 12);
	expect((await uiRead(one, 'totals', load, 0)).value).toBe(12);
	await uiRead(one, 'totals', load, 0);
	expect(load).toHaveBeenCalledTimes(1);
	await uiRead(two, 'totals', load, 0);
	expect(load).toHaveBeenCalledTimes(2);
	invalidateUiReads(one);
	await uiRead(one, 'totals', load, 0);
	expect(load).toHaveBeenCalledTimes(3);
});
it('retains a recent successful value under pressure, bounds stale age, and cools down failures', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const binding = db();
	await uiRead(binding, 'totals', async () => 42, 0);
	await vi.advanceTimersByTimeAsync(30_001);
	const load = vi.fn(busy);
	expect(await uiRead(binding, 'totals', load, 0)).toMatchObject({
		value: 42,
		stale: true,
		unavailable: false,
		at: 1_000_000
	});
	await uiRead(binding, 'totals', load, 0);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(300_001);
	expect(await uiRead(binding, 'totals', load, 0)).toMatchObject({
		value: 0,
		stale: false,
		unavailable: true,
		at: null
	});
});
it('does not turn a valid cached null into a fallback or hide programming errors', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const binding = db();
	await uiRead<string | null>(binding, 'limit', async () => null, 'fallback', 0);
	expect((await uiRead(binding, 'limit', busy, 'fallback', 0)).value).toBeNull();
	await expect(
		uiRead(
			binding,
			'broken',
			async () => {
				throw new Error('no such column');
			},
			0
		)
	).rejects.toThrow('no such column');
});
it('an invalidated in-flight read cannot resurrect its cached or fallback value', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const binding = db();
	let complete!: (value: number) => void;
	const old = uiRead(
		binding,
		'total',
		() =>
			new Promise<number>((r) => {
				complete = r;
			}),
		0
	);
	invalidateUiReads(binding);
	complete(7);
	await old;
	expect(await uiRead(binding, 'total', busy, 0)).toMatchObject({ value: 0, unavailable: true });
});
it('joins overlapping display reads without awaiting another request-owned promise', async () => {
	vi.useFakeTimers();
	const binding = db();
	let complete!: (value: number) => void;
	const load = vi.fn(
		() =>
			new Promise<number>((r) => {
				complete = r;
			})
	);
	const first = uiRead(binding, 'total', load, 0),
		second = uiRead(binding, 'total', load, 0);
	complete(9);
	await vi.advanceTimersByTimeAsync(50);
	expect((await first).value).toBe(9);
	expect((await second).value).toBe(9);
	expect(load).toHaveBeenCalledOnce();
});
