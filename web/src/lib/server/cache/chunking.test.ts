// Differential boundary tests for the FastCDC cutter. The Go CLI ships a
// bit-identical implementation (internal/chunker); its differential test
// (differential_test.go) generates THE SAME inputs from the same splitmix32
// streams and asserts THE SAME pinned digests. If either side drifts — gear
// table, masks, min/avg/max, scan order — its digest changes and one suite
// fails. Never update a digest here without updating the Go twin (and
// accepting that stored chunk identities change).

import { describe, expect, it } from 'vitest';
import { FastCdcChunker, chunkBuffer } from './chunking';

/** splitmix32 byte stream: each 32-bit output contributes 4 little-endian
 *  bytes. Must match prngBytes in the Go differential test exactly. */
function prngBytes(seed: number, length: number): Uint8Array {
	const out = new Uint8Array(length);
	let s = seed >>> 0;
	for (let i = 0; i < length; i += 4) {
		s = (s + 0x9e3779b9) >>> 0;
		let z = s;
		z ^= z >>> 16;
		z = Math.imul(z, 0x21f0aaad);
		z ^= z >>> 15;
		z = Math.imul(z, 0x735a2d97);
		z ^= z >>> 15;
		z = z >>> 0;
		out[i] = z & 0xff;
		if (i + 1 < length) out[i + 1] = (z >>> 8) & 0xff;
		if (i + 2 < length) out[i + 2] = (z >>> 16) & 0xff;
		if (i + 3 < length) out[i + 3] = (z >>> 24) & 0xff;
	}
	return out;
}

const MiB = 1024 * 1024;

/** Shared corpus. Name, generator, and pinned boundary digest — one entry per
 *  adversarial shape (uniform random, all-zero, periodic, mixed runs, sub-min,
 *  exact-max multiples). */
const CASES: { name: string; data: () => Uint8Array; digest: string }[] = [
	{
		name: 'random-40MiB',
		data: () => prngBytes(1, 40 * MiB),
		digest: 'a54ec757d8fa6b6cd59c596c353c9a971dd46d2dd66509bcecc960ef4997e231'
	},
	{
		name: 'zeros-24MiB',
		data: () => new Uint8Array(24 * MiB),
		digest: '072b0c7944560a97e7c5e0282d05a1299e28586d3217e3e90e2182b42ad5747a'
	},
	{
		name: 'repeat-1KiB-24MiB',
		data: () => {
			const block = prngBytes(2, 1024);
			const out = new Uint8Array(24 * MiB);
			for (let i = 0; i < out.length; i += 1024) out.set(block, i);
			return out;
		},
		digest: '072b0c7944560a97e7c5e0282d05a1299e28586d3217e3e90e2182b42ad5747a'
	},
	{
		name: 'random-with-zero-runs-32MiB',
		data: () => {
			// 512 KiB zero run at every 3 MiB mark: exercises boundary behavior
			// where the gear hash goes monotonic mid-window.
			const out = prngBytes(3, 32 * MiB);
			for (let mark = 3 * MiB; mark + 512 * 1024 <= out.length; mark += 3 * MiB) {
				out.fill(0, mark, mark + 512 * 1024);
			}
			return out;
		},
		digest: 'ad79dae0d9e3dd99796336d6c43b3024b75c9f268b47bae1df4f373d5b9f4efe'
	},
	{
		name: 'sub-min-1MiB',
		data: () => prngBytes(4, MiB),
		digest: '50b4b069390c1d7966da182649bb2caddb412a2f9012425b5e9ec0ef4ec68545'
	},
	{
		name: 'max-exact-32MiB-zeros',
		data: () => new Uint8Array(32 * MiB),
		digest: '68b4798f3bf07a216ebea4318987df86db3fd08d305638d66ca3966f354f4999'
	}
];

async function boundaryDigest(chunks: Uint8Array[]): Promise<string> {
	const lengths = chunks.map((c) => c.length).join(',');
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lengths));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('FastCDC differential corpus (Go twin: internal/chunker/differential_test.go)', () => {
	for (const c of CASES) {
		it(`pins boundaries for ${c.name}`, async () => {
			const data = c.data();
			const chunks = chunkBuffer(data);
			// Invariants regardless of digest: sizes within bounds, lossless.
			const total = chunks.reduce((n, ch) => n + ch.length, 0);
			expect(total).toBe(data.length);
			for (const ch of chunks.slice(0, -1)) {
				expect(ch.length).toBeGreaterThanOrEqual(2 * MiB);
			}
			for (const ch of chunks) {
				expect(ch.length).toBeLessThanOrEqual(16 * MiB);
			}
			expect(await boundaryDigest(chunks)).toBe(c.digest);
		});
	}

	it('cuts identically regardless of push granularity', async () => {
		const data = prngBytes(5, 24 * MiB);
		const oneShot = chunkBuffer(data);

		const incremental: Uint8Array[] = [];
		const chunker = new FastCdcChunker();
		// Prime-sized pushes so block edges never align with chunk boundaries.
		const step = 65537;
		for (let off = 0; off < data.length; off += step) {
			incremental.push(...chunker.push(data.subarray(off, Math.min(off + step, data.length))));
		}
		const rest = chunker.finish();
		if (rest) incremental.push(rest);

		expect(await boundaryDigest(incremental)).toBe(await boundaryDigest(oneShot));
	});
});
