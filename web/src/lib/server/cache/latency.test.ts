import { afterEach, expect, it, vi } from 'vitest';
import {
	countD1,
	countLoopbackFallback,
	measure,
	observeRequest,
	streamObservation
} from './latency';
import type { D1Result } from '@cloudflare/workers-types';

afterEach(() => vi.restoreAllMocks());

it('appends diagnostics without moving existing Analytics Engine positions', async () => {
	vi.spyOn(Math, 'random').mockReturnValue(0);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	const writeDataPoint = vi.fn();
	const env = { CACHE_METRICS: { writeDataPoint } } as unknown as App.Platform['env'];
	await observeRequest(new Request('https://cache.test/nar/abc.nar'), env, 'store', async () => {
		countLoopbackFallback();
		countD1(1, [
			{
				meta: {
					rows_read: 3,
					rows_written: 2,
					served_by_primary: true,
					served_by_region: 'ENAM',
					timings: { sql_duration_ms: 7 },
					total_attempts: 2
				}
			}
		] as D1Result[]);
		return measure(
			'manifest',
			async () => new Response('ok', { headers: { 'Content-Length': '2' } })
		);
	});
	const { blobs, doubles } = writeDataPoint.mock.calls[0][0];
	// blob7 (the D1 region) is appended after the original six.
	expect(blobs).toEqual(['latency', 'store', 'GET /nar/:file', 'NONE', 'unknown', '200', 'ENAM']);
	expect(doubles).toHaveLength(20);
	expect(doubles.slice(2, 8)).toEqual([1, 3, 2, 0, 1, 2]);
	expect(doubles[15]).toBe(1);
	expect(doubles[16]).toBeGreaterThanOrEqual(0);
	expect(doubles.slice(17)).toEqual([1, 7, 7]);
});

it('samples uploads even when a read would be skipped, and records post-header fallbacks', async () => {
	vi.spyOn(Math, 'random').mockReturnValue(0.99);
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const env = {} as App.Platform['env'];
	await observeRequest(
		new Request('https://cache.test/_api/v1/upload-path/chunks/complete', { method: 'POST' }),
		env,
		'gateway',
		async () => {
			return new Response(null, { status: 503 });
		}
	);
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
		route: 'POST /_api/v1/upload-path/chunks/complete',
		status: 503
	});
	vi.spyOn(Math, 'random').mockReturnValue(0);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let pumping!: Promise<void>;
	await observeRequest(
		new Request('https://cache.test/_nar_v2/abc.nar'),
		env,
		'store',
		async () => {
			const stream = streamObservation(2, 10);
			pumping = stream.wait(gate).then(() => {
				countLoopbackFallback();
				stream.finish('error');
			});
			return new Response();
		}
	);
	expect(JSON.parse(log.mock.calls.at(-1)![0]).loopbackFallbacks).toBe(0);
	release();
	await pumping;
	expect(log.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
		expect.objectContaining({
			event: 'nimbus.stream',
			loopbackFallbacks: 1,
			retries: 1,
			status: 'error',
			chunks: 2,
			sampled: true
		})
	);
});

it('logs stream completion even for unsampled requests', async () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	streamObservation(48, null).finish('ok');
	const event = JSON.parse(log.mock.calls.at(-1)![0]);
	expect(event).toMatchObject({ event: 'nimbus.stream', chunks: 48, sampled: false });
	expect(event).not.toHaveProperty('retries');
});
