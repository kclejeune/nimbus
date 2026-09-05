import { describe, expect, it, vi } from 'vitest';
import { readJson } from './request-body';
import { MAX_MISSING_PATHS, readDeviceCode, readMissingPaths } from './cache/request-input';

function request(body: unknown) {
	return new Request('https://cache.example/_api/v1/get-missing-paths', {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

describe('bounded JSON', () => {
	it('enforces actual stream bytes even with a false Content-Length', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode('"123456789"'));
			},
			cancel
		});
		const req = new Request('https://example.com', {
			method: 'POST',
			body,
			duplex: 'half',
			headers: { 'Content-Length': '1' }
		} as RequestInit);
		await expect(readJson(req, 8)).rejects.toMatchObject({ status: 413 });
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('counts UTF-8 bytes and accepts the exact limit', async () => {
		await expect(readJson(request('é'), 4)).resolves.toBe('é');
		await expect(readJson(request('é'), 3)).rejects.toMatchObject({ status: 413 });
	});
	it('rejects malformed JSON', async () => {
		await expect(
			readJson(new Request('https://example.com', { method: 'POST', body: '{' }), 10)
		).rejects.toMatchObject({ status: 400 });
	});
});

describe('cache request validation', () => {
	const hash = 'a'.repeat(32);
	it('deduplicates valid hashes while preserving order', async () => {
		const body = await readMissingPaths(
			request({ cache: 'test', store_path_hashes: [hash, 'b'.repeat(32), hash] })
		);
		expect(body.hashes).toEqual([hash, 'b'.repeat(32)]);
	});
	it.each([
		null,
		[],
		{ cache: 'test', store_path_hashes: [42] },
		{ cache: 'test', store_path_hashes: ['e'.repeat(32)] },
		{ cache: 'test', store_path_hashes: [], ignore_upstream_cache_filter: 'false' }
	])('rejects invalid input before DB work: %j', async (body) => {
		await expect(readMissingPaths(request(body))).rejects.toMatchObject({ status: 400 });
	});
	it('caps the submitted count before deduplication', async () => {
		await expect(
			readMissingPaths(
				request({ cache: 'test', store_path_hashes: Array(MAX_MISSING_PATHS).fill(hash) })
			)
		).resolves.toMatchObject({ hashes: [hash] });
		await expect(
			readMissingPaths(
				request({ cache: 'test', store_path_hashes: Array(MAX_MISSING_PATHS + 1).fill(hash) })
			)
		).rejects.toMatchObject({ status: 413 });
	});
	it('only accepts device codes the server can issue', async () => {
		await expect(readDeviceCode(request({ device_code: 'f'.repeat(64) }))).resolves.toBe(
			'f'.repeat(64)
		);
		for (const device_code of [true, {}, 123, 'short', 'g'.repeat(64)]) {
			await expect(readDeviceCode(request({ device_code }))).rejects.toMatchObject({ status: 400 });
		}
		await expect(
			readDeviceCode(request({ device_code: 'f'.repeat(64), extra: 'x'.repeat(1024) }))
		).rejects.toMatchObject({ status: 413 });
	});
});
