import { describe, expect, it, vi } from 'vitest';
import { mapConcurrent, readAll, Semaphore, withSlot } from './platform';
import { BODY_IDLE_TIMEOUT_MS } from '../request-body';

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

it.each([undefined, 0, 2, 6, 20])(
	'bounds body bytes independently of a size hint (%s)',
	async (size) => {
		const source = () =>
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1, 2]));
					c.enqueue(new Uint8Array([3, 4, 5, 6]));
					c.close();
				}
			});
		const body = source();
		const bytes = await readAll(body, 10, size);
		expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
		expect(bytes!.buffer.byteLength).toBe(6);
		expect(body.locked).toBe(false);
		const oversized = source();
		expect(await readAll(oversized, 5, size)).toBe(null);
		expect(oversized.locked).toBe(false);
	}
);

it('releases a body reader after a transfer error', async () => {
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.error(new Error('disconnected'));
		}
	});
	await expect(readAll(body, 10, 10)).rejects.toThrow('disconnected');
	expect(body.locked).toBe(false);
});

it.each([0, 2, 6, 10])('preserves bytes across BYOB transfers with size hint %s', async (size) => {
	const source = () =>
		new ReadableStream<Uint8Array>({
			type: 'bytes',
			start(c) {
				c.enqueue(new Uint8Array([1, 2]));
				c.enqueue(new Uint8Array([3, 4, 5, 6]));
				c.close();
			}
		});
	const body = source();
	const bytes = await readAll(body, 10, size);
	expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
	expect(bytes!.buffer.byteLength).toBe(6);
	expect(body.locked).toBe(false);
	const oversized = source();
	expect(await readAll(oversized, 5, Math.min(size, 5))).toBe(null);
	expect(oversized.locked).toBe(false);
});

it('cancels an idle BYOB read without keeping the reader locked', async () => {
	vi.useFakeTimers();
	try {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ type: 'bytes', cancel });
		const reading = readAll(body, 10, 10);
		const failed = expect(reading).rejects.toThrow('Request body stalled');
		await vi.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS);
		await failed;
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	} finally {
		vi.useRealTimers();
	}
});
