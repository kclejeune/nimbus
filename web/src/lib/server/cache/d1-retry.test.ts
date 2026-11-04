import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { isTransientD1Error, releaseNarLock, touchObjectsForNarHash, withD1Retry } from './db';
import { withD1ReadBudget } from './d1-read-budget';

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Math, 'random').mockReturnValue(0);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('recognizes only the observed internal-reference form, and only for safe reads', () => {
	const error = new Error('D1_ERROR: internal error; reference = gfn24hl78f1si45pirsq8c9r');
	expect(isTransientD1Error(error)).toBe(false);
	expect(isTransientD1Error(error, true)).toBe(true);
	expect(isTransientD1Error(new Error('internal error'), true)).toBe(false);
	expect(
		isTransientD1Error(new Error('D1_ERROR: no such table: internal error; reference = abc'), true)
	).toBe(false);
});

it('backs off overload retries at 250, 500 and 1000 ms before jitter', async () => {
	const times: number[] = [];
	const start = Date.now();
	const run = vi.fn(async () => {
		times.push(Date.now() - start);
		if (times.length < 4) throw new Error('D1 DB is overloaded. Too many requests queued.');
		return 'ok';
	});
	const result = withD1Retry(run);
	await vi.advanceTimersByTimeAsync(1_750);
	expect(await result).toBe('ok');
	expect(times).toEqual([0, 250, 750, 1_750]);
});

it('does not start a retry that would exceed the read retry window', async () => {
	const run = vi.fn(async () => {
		await new Promise((resolve) => setTimeout(resolve, 4_900));
		throw new Error('D1 DB is overloaded');
	});
	const result = withD1ReadBudget(() => withD1Retry(run));
	const failed = expect(result).rejects.toThrow('overloaded');
	await vi.advanceTimersByTimeAsync(5_000);
	await failed;
	expect(run).toHaveBeenCalledOnce();
});

it('allows all initial statements of a multi-query configuration read', async () => {
	const read = vi.fn(async () => 'row');
	expect(
		await withD1ReadBudget(() => Promise.all(Array.from({ length: 6 }, () => withD1Retry(read))))
	).toEqual(Array(6).fill('row'));
	expect(read).toHaveBeenCalledTimes(6);
});

it('retries internal-reference errors inside a read scope without replaying ordinary writes', async () => {
	const error = new Error('D1_ERROR: internal error; reference = abc123');
	const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
	const result = withD1ReadBudget(() => withD1Retry(read));
	await vi.advanceTimersByTimeAsync(40);
	expect(await result).toBe('ok');
	const write = vi.fn().mockRejectedValue(error);
	await expect(withD1Retry(write)).rejects.toBe(error);
	expect(write).toHaveBeenCalledOnce();
});

it.each(['probe', 'update'])(
	'does not retry a best-effort download touch after its %s fails',
	async (phase) => {
		const error = new Error('D1 DB is overloaded');
		const all = vi.fn().mockImplementation(async () => {
			if (phase === 'probe') throw error;
			return { results: [{ id: 1 }], meta: {} };
		});
		const run = vi.fn().mockRejectedValue(error);
		const stmt = { bind: () => stmt, all, run };
		const db = { prepare: () => stmt } as unknown as D1Database;
		await expect(touchObjectsForNarHash(db, 1, 'hash')).rejects.toBe(error);
		expect(all).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledTimes(phase === 'update' ? 1 : 0);
		expect(vi.getTimerCount()).toBe(0);
	}
);

it('preserves the single-attempt policy for hold releases', async () => {
	const error = new Error('D1 DB is overloaded');
	const run = vi.fn().mockRejectedValue(error);
	const stmt = { bind: () => stmt, run };
	const db = { prepare: () => stmt } as unknown as D1Database;
	await expect(releaseNarLock(db, 1)).rejects.toBe(error);
	expect(run).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
