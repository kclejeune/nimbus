import { describe, expect, it } from 'vitest';
import { Semaphore, withSlot } from './platform';

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
		expect(sem.tryAcquire()).toBe(true);
	});
});
