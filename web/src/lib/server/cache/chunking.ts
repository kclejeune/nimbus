// FastCDC content-defined chunking for NAR uploads. Chunk boundaries depend
// only on content, so shifted or partially-changed NARs still dedup against
// previously stored chunks.
//
// Parameters are much larger than the reference server's 16/64/256 KiB: every
// chunk costs one R2 subrequest on upload and download, and Workers cap
// subrequests per invocation, so we target ~8 MiB chunks (a 500 MB NAR is
// ~64 chunks). Boundaries are self-consistent within this store only; they
// intentionally do not match the Rust implementation's.

/** NARs at least this large are chunked; smaller ones stay whole. */
export const NAR_CHUNK_THRESHOLD = 8 * 1024 * 1024;

const MIN_CHUNK = 2 * 1024 * 1024;
const AVG_CHUNK_BITS = 23; // 8 MiB
const AVG_CHUNK = 1 << AVG_CHUNK_BITS;
const MAX_CHUNK = 16 * 1024 * 1024;

// FastCDC normalization: a stricter mask before the average size, a looser
// one after, pulling the size distribution toward AVG_CHUNK.
const MASK_S = (1 << (AVG_CHUNK_BITS + 1)) - 1;
const MASK_L = (1 << (AVG_CHUNK_BITS - 1)) - 1;

// Deterministic 31-bit gear table (splitmix32). The values are arbitrary but
// must never change: chunk boundaries — and therefore dedup — depend on them.
const GEAR = (() => {
	let s = 0x9e3779b9 >>> 0;
	const next = () => {
		s = (s + 0x9e3779b9) >>> 0;
		let z = s;
		z ^= z >>> 16;
		z = Math.imul(z, 0x21f0aaad);
		z ^= z >>> 15;
		z = Math.imul(z, 0x735a2d97);
		z ^= z >>> 15;
		return z >>> 0;
	};
	return Uint32Array.from({ length: 256 }, () => next() & 0x7fffffff);
})();

/**
 * Incremental FastCDC chunker: feed arbitrary blocks with push(), which
 * returns any chunks completed by that data; finish() returns the remainder.
 */
export class FastCdcChunker {
	// Holds the current unfinished chunk plus incoming slack. A cut is forced
	// at MAX_CHUNK, so len never exceeds MAX_CHUNK for long.
	private buf = new Uint8Array(MAX_CHUNK * 2);
	private len = 0;
	private scanned = 0;
	private hash = 0;

	push(data: Uint8Array): Uint8Array[] {
		const out: Uint8Array[] = [];
		let offset = 0;
		while (offset < data.length) {
			const take = Math.min(this.buf.length - this.len, data.length - offset);
			this.buf.set(data.subarray(offset, offset + take), this.len);
			this.len += take;
			offset += take;
			this.scan(out);
		}
		return out;
	}

	finish(): Uint8Array | null {
		if (this.len === 0) return null;
		const rest = this.buf.slice(0, this.len);
		this.len = 0;
		this.scanned = 0;
		this.hash = 0;
		return rest;
	}

	private scan(out: Uint8Array[]): void {
		let i = this.scanned;
		let hash = this.hash;
		while (i < this.len) {
			hash = ((hash << 1) + GEAR[this.buf[i]]) & 0x7fffffff;
			i++;
			if (i < MIN_CHUNK) continue;
			const mask = i < AVG_CHUNK ? MASK_S : MASK_L;
			if ((hash & mask) === 0 || i >= MAX_CHUNK) {
				out.push(this.buf.slice(0, i));
				this.buf.copyWithin(0, i, this.len);
				this.len -= i;
				i = 0;
				hash = 0;
			}
		}
		this.scanned = i;
		this.hash = hash;
	}
}

/** One-shot chunking for fully buffered NARs. */
export function chunkBuffer(data: Uint8Array): Uint8Array[] {
	const chunker = new FastCdcChunker();
	const chunks = chunker.push(data);
	const rest = chunker.finish();
	if (rest) chunks.push(rest);
	return chunks;
}
