import { describe, expect, it } from 'vitest';
import { mapConcurrent, Semaphore, withSlot } from './platform';

describe('Semaphore', () => {
	it('bounds concurrency and lets every waiter through', async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;
		const task = () =>
			withSlot(sem, async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 10));
				active--;
			});
		await Promise.all(Array.from({ length: 8 }, task));
		expect(peak).toBeLessThanOrEqual(2);
		expect(active).toBe(0);
	});

	it('releases the slot when fn throws', async () => {
		const sem = new Semaphore(1);
		await expect(withSlot(sem, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
		// Only resolves if the slot was released.
		await withSlot(sem, async () => {});
	});
});

describe('mapConcurrent', () => {
	it('preserves input order in the results', async () => {
		const results = await mapConcurrent([3, 1, 2], 2, async (n) => {
			await new Promise((r) => setTimeout(r, n * 5));
			return n * 10;
		});
		expect(results).toEqual([30, 10, 20]);
	});

	it('bounds concurrency with rolling admission', async () => {
		let active = 0;
		let peak = 0;
		await mapConcurrent(
			Array.from({ length: 10 }, (_, i) => i),
			3,
			async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
			}
		);
		expect(peak).toBeLessThanOrEqual(3);
		expect(active).toBe(0);
	});

	it('handles an empty list and a limit above the item count', async () => {
		expect(await mapConcurrent([], 4, async (n) => n)).toEqual([]);
		expect(await mapConcurrent([1], 4, async (n) => n + 1)).toEqual([2]);
	});

	it('stops admitting new items after a failure', async () => {
		const started: number[] = [];
		await expect(
			mapConcurrent([1, 2, 3, 4], 1, async (n) => {
				started.push(n);
				if (n === 2) throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(started).toEqual([1, 2]);
	});

	it('propagates a rejection after in-flight tasks settle', async () => {
		let completed = 0;
		await expect(
			mapConcurrent([1, 2, 3], 2, async (n) => {
				if (n === 1) throw new Error('boom');
				await new Promise((r) => setTimeout(r, 5));
				completed++;
			})
		).rejects.toThrow('boom');
		// The other worker's tasks were not abandoned mid-flight.
		expect(completed).toBeGreaterThan(0);
	});
});
