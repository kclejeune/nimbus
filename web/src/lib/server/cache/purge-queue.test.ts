import { testPurgeQueue } from './test-purge-queue';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PurgeQueue, PURGE_COOLDOWN_MS, PURGE_INTERVAL_MS, type PurgeResult } from './purge-queue';

const databases: DatabaseSync[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
});
afterEach(() => {
	vi.useRealTimers();
	for (const db of databases.splice(0)) db.close();
});

function fixture(purge?: Parameters<typeof testPurgeQueue>[0]) {
	const result = testPurgeQueue(purge);
	databases.push(result.sqlite);
	return result;
}

it('batches across callers, paces attempts and stops alarms when drained', async () => {
	const f = fixture();
	await Promise.all(Array.from({ length: 150 }, (_, i) => f.queue.enqueue([`tag-${i}`, 'shared'])));
	expect(f.depth()).toBe(151);
	expect(f.purge).not.toHaveBeenCalled();
	await f.queue.alarm();
	expect(f.purge.mock.calls[0][0]).toHaveLength(100);
	expect(f.depth()).toBe(51);
	await f.queue.alarm();
	expect(f.purge).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(PURGE_INTERVAL_MS);
	await f.queue.alarm();
	expect(f.depth()).toBe(0);
	expect(f.alarm()).toBeNull();
});

it('persists pacing and obligations across restarts and rate limits', async () => {
	const f = fixture(vi.fn(async () => ({ success: false, rateLimited: true })));
	expect(await f.queue.enqueue(['a'], true)).toEqual({ confirmed: false });
	expect(f.depth()).toBe(1);
	expect(f.alarm()).toBe(Date.now() + PURGE_COOLDOWN_MS);
	const recovered = vi.fn(async () => ({ success: true }));
	const restarted = new PurgeQueue(f.storage, recovered);
	await restarted.alarm();
	expect(recovered).not.toHaveBeenCalled();
	vi.advanceTimersByTime(PURGE_COOLDOWN_MS);
	await restarted.alarm();
	expect(recovered).toHaveBeenCalledOnce();
	expect(f.depth()).toBe(0);
});

it('retains ambiguous RPC failures and only confirms an actual eviction', async () => {
	const f = fixture(
		vi.fn(async () => {
			throw new Error('connection lost');
		})
	);
	expect(await f.queue.enqueue(['a'], true)).toEqual({ confirmed: false });
	expect(f.depth()).toBe(1);
	f.purge.mockResolvedValue({ success: true });
	vi.advanceTimersByTime(PURGE_INTERVAL_MS);
	expect(await f.queue.enqueue(['a'], true)).toEqual({ confirmed: true });
	expect(await f.queue.enqueue(['b'], true)).toEqual({ confirmed: false });
	expect(f.depth()).toBe(1);
});

it('does not retire a tag re-enqueued during an earlier purge', async () => {
	let resolve!: (result: PurgeResult) => void;
	const f = fixture(
		vi.fn(
			() =>
				new Promise<PurgeResult>((r) => {
					resolve = r;
				})
		)
	);
	await f.queue.enqueue(['a']);
	const flushing = f.queue.alarm();
	await vi.waitFor(() => expect(f.purge).toHaveBeenCalledOnce());
	await f.queue.enqueue(['a']);
	resolve({ success: true });
	await flushing;
	expect(f.depth()).toBe(1);
	f.purge.mockResolvedValue({ success: true });
	vi.advanceTimersByTime(PURGE_INTERVAL_MS);
	await f.queue.alarm();
	expect(f.depth()).toBe(0);
});

it('prioritizes confirmed-purge callers over routine upload invalidations', async () => {
	const f = fixture();
	await f.queue.enqueue(Array.from({ length: 100 }, (_, i) => `routine-${i}`));
	expect(await f.queue.enqueue(['withdrawal'], true)).toEqual({ confirmed: true });
	expect(f.purge.mock.calls[0][0][0]).toBe('withdrawal');
	expect(f.depth()).toBe(1);
});

it('recovers an abandoned in-flight request without accepting its late result', async () => {
	let resolve!: (result: PurgeResult) => void;
	const f = fixture(
		vi.fn(
			() =>
				new Promise<PurgeResult>((r) => {
					resolve = r;
				})
		)
	);
	await f.queue.enqueue(['a']);
	const abandoned = f.queue.alarm();
	await vi.waitFor(() => expect(f.purge).toHaveBeenCalledOnce());
	vi.advanceTimersByTime(PURGE_INTERVAL_MS);
	await f.queue.alarm();
	expect(f.alarm()).not.toBeNull();
	vi.advanceTimersByTime(30_000);
	f.purge.mockResolvedValue({ success: false, rateLimited: true });
	await f.queue.alarm();
	resolve({ success: true });
	await abandoned;
	expect(f.depth()).toBe(1);
	expect(f.alarm()).toBe(Date.now() + PURGE_COOLDOWN_MS);
});

it('does not acknowledge a repair submitted during an earlier purge', async () => {
	let resolve!: (result: PurgeResult) => void;
	const f = fixture(
		vi.fn(
			() =>
				new Promise<PurgeResult>((r) => {
					resolve = r;
				})
		)
	);
	await f.queue.enqueue(['tag']);
	const flushing = f.queue.alarm();
	await vi.waitFor(() => expect(f.purge).toHaveBeenCalledOnce());
	expect(await f.queue.repairPurge('job', 'page', ['tag'])).toBe(false);
	resolve({ success: true });
	await flushing;
	expect(await f.queue.repairPurge('job', 'page', ['tag'])).toBe(false);
	f.purge.mockResolvedValue({ success: true });
	vi.advanceTimersByTime(PURGE_INTERVAL_MS);
	await f.queue.alarm();
	expect(await f.queue.repairPurge('job', 'page', ['tag'])).toBe(true);
	// A later upload creates a new obligation but cannot undo this receipt.
	await f.queue.enqueue(['tag']);
	expect(await f.queue.repairPurge('job', 'page', ['tag'])).toBe(true);
	expect(f.depth()).toBe(1);
});

it('resumes multiple repair jobs after restart and rate-limit recovery without polling pending pages', async () => {
	const purge = vi.fn(async (): Promise<PurgeResult> => ({ success: false, rateLimited: true }));
	const f = fixture(purge);
	let queue: PurgeQueue;
	const resume = vi.fn(async (key: string) =>
		(await queue.repairPurge(key, 'page', [key])) ? null : Date.now() + 12_000
	);
	queue = new PurgeQueue(f.storage, purge, resume);
	await queue.scheduleRepair('a');
	await queue.scheduleRepair('b');
	await queue.alarm();
	expect(resume).toHaveBeenCalledTimes(2);
	await queue.alarm();
	expect(purge).toHaveBeenCalledOnce();
	vi.advanceTimersByTime(12_000);
	await queue.alarm();
	expect(resume).toHaveBeenCalledTimes(2);
	purge.mockResolvedValue({ success: true });
	queue = new PurgeQueue(f.storage, purge, resume);
	vi.advanceTimersByTime(PURGE_COOLDOWN_MS);
	await queue.alarm();
	expect(resume).toHaveBeenCalledTimes(4);
	expect(f.alarm()).toBeNull();
	expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM repair_schedule').get()!.n).toBe(0);
});

it('persists continuation retries before failures and preserves retirement timers', async () => {
	const f = fixture();
	const resume = vi
		.fn<(key: string) => Promise<number | null>>()
		.mockRejectedValueOnce(new Error('D1 unavailable'))
		.mockResolvedValueOnce(Date.now() + 300_000)
		.mockResolvedValueOnce(null);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		let queue = new PurgeQueue(f.storage, f.purge, resume);
		await queue.scheduleRepair('job');
		await queue.alarm();
		expect(f.alarm()).toBe(Date.now() + 60_000);
		queue = new PurgeQueue(f.storage, f.purge, resume);
		vi.advanceTimersByTime(60_000);
		await queue.alarm();
		expect(f.alarm()).toBe(400_000);
		// Repeated cron scheduling must not shorten the retirement grace period.
		await queue.scheduleRepair('job');
		expect(f.alarm()).toBe(400_000);
		vi.setSystemTime(400_000);
		await queue.alarm();
		expect(f.alarm()).toBeNull();
	} finally {
		warn.mockRestore();
	}
});
