import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeUploadChunk } from './upload-observation';

const chunk = { narHash: 'nar', index: 2, chunkHash: 'chunk', rawBytes: 8, expectedBytes: 6 };
const memory = () => ({
	isolate: 'test-isolate',
	totalBytes: 64,
	usedBytes: 32,
	active: 1,
	maxActive: 8,
	queued: 2,
	prefetchBytes: 0,
	prefetchActive: 0
});
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('logs pending source bytes and idle time, then stops its timer when the read ends', async () => {
	let finish!: (bytes: Uint8Array) => void;
	let progress!: (bytes: number) => void;
	const reading = observeUploadChunk('body', chunk, memory, (report) => {
		progress = report;
		return new Promise<Uint8Array>((resolve) => (finish = resolve));
	});
	await vi.advanceTimersByTimeAsync(4_000);
	progress(4);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
		event: 'nimbus.upload_chunk',
		phase: 'body',
		status: 'pending',
		...chunk,
		bytes: 4,
		ms: 5_000,
		idleMs: 1_000,
		memory: memory()
	});
	await vi.advanceTimersByTimeAsync(15_000);
	expect(vi.mocked(console.log)).toHaveBeenCalledTimes(2);
	progress(6);
	finish(new Uint8Array(6));
	await reading;
	expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
		status: 'ok',
		bytes: 6,
		ms: 20_000,
		idleMs: 0
	});
	await vi.advanceTimersByTimeAsync(60_000);
	expect(vi.mocked(console.log)).toHaveBeenCalledTimes(3);
	expect(vi.getTimerCount()).toBe(0);
});

it('records a slow get without requiring trace sampling or waiting for a pending log', async () => {
	const result = observeUploadChunk('get', chunk, memory, async () => {
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		return 'object';
	});
	await vi.advanceTimersByTimeAsync(1_500);
	expect(await result).toBe('object');
	expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
		phase: 'get',
		status: 'ok',
		ms: 1_500
	});
	expect(vi.getTimerCount()).toBe(0);
});

it('does not log fast successful chunks', async () => {
	expect(
		await observeUploadChunk('body', chunk, memory, async () => new Uint8Array(6))
	).toHaveLength(6);
	expect(console.log).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
	'distinguishes speculative cancellation from storage failure, cancelled=%s',
	async (cancelled) => {
		const abort = new AbortController();
		if (cancelled) abort.abort();
		const error = new Error('source stopped');
		await expect(
			observeUploadChunk(
				'body',
				chunk,
				memory,
				async () => {
					throw error;
				},
				abort.signal
			)
		).rejects.toBe(error);
		const log = vi.mocked(cancelled ? console.log : console.warn);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
			phase: 'body',
			status: cancelled ? 'cancelled' : 'error',
			error: 'source stopped'
		});
		expect(vi.getTimerCount()).toBe(0);
	}
);
