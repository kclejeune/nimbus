import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { compressBuffer } from './index';

// Exercise hashing with a deterministic codec; workerd smoke tests cover WASM.
vi.mock('./zstd', () => ({
	initZstd: async () => {},
	zstdCompress: (input: Uint8Array) => new Uint8Array([42, ...input]),
	zstdDecompress: vi.fn()
}));
afterEach(() => vi.restoreAllMocks());
const hash = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');

it('reuses a locally verified raw hash while independently hashing compressed bytes', async () => {
	const input = new Uint8Array([1, 2, 3]);
	const digest = vi.spyOn(crypto.subtle, 'digest');
	const result = await compressBuffer(input, 'zstd', hash(input));
	expect(result.narHash).toBe(hash(input));
	expect(result.fileHash).toBe(hash(result.data));
	expect(result.fileHash).not.toBe(result.narHash);
	expect(digest).toHaveBeenCalledOnce();
});

it('computes the raw hash when the caller has not verified it', async () => {
	const input = new Uint8Array([4, 5, 6]);
	const digest = vi.spyOn(crypto.subtle, 'digest');
	const result = await compressBuffer(input, 'zstd');
	expect(result.narHash).toBe(hash(input));
	expect(result.fileHash).toBe(hash(result.data));
	expect(digest).toHaveBeenCalledTimes(2);
});

it('uncompressed bytes share one independently computed raw and file hash', async () => {
	const input = new Uint8Array([7, 8, 9]);
	const digest = vi.spyOn(crypto.subtle, 'digest');
	const result = await compressBuffer(input, 'none');
	expect(result.data).toBe(input);
	expect(result.narHash).toBe(hash(input));
	expect(result.fileHash).toBe(result.narHash);
	expect(digest).toHaveBeenCalledOnce();
});
