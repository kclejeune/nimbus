import { expect, it, vi } from 'vitest';
import { prefetchInOrder } from './prefetch';

it('disposes a late unused load in the request background without delaying early exit', async () => {
	let resolve!: (value: number) => void;
	const late = new Promise<number>((done) => (resolve = done));
	const disposed = vi.fn(async (_value: number) => {});
	const tasks: Promise<unknown>[] = [];
	const loaded: number[] = [];
	for await (const value of prefetchInOrder(
		[1, 2, 3],
		1,
		async (item) => {
			loaded.push(item);
			return item === 2 ? late : item;
		},
		disposed,
		(cleanup) => void tasks.push(cleanup)
	)) {
		expect(value).toBe(1);
		break;
	}
	expect(loaded).toEqual([1, 2]);
	expect(disposed).toHaveBeenCalledExactlyOnceWith(1);
	expect(tasks).toHaveLength(1);
	resolve(2);
	await Promise.all(tasks);
	expect(disposed).toHaveBeenCalledWith(2);
});

it('handles a prefetched rejection after an earlier consumer failure', async () => {
	const disposed = vi.fn(async (_value: number) => {});
	const work = async () => {
		for await (const _value of prefetchInOrder(
			[1, 2],
			1,
			async (item) => {
				if (item === 2) throw new Error('storage unavailable');
				return item;
			},
			disposed
		))
			throw new Error('invalid chunk');
	};
	await expect(work()).rejects.toThrow('invalid chunk');
	expect(disposed).toHaveBeenCalledExactlyOnceWith(1);
});
