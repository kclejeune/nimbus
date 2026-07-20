// Server-side NAR compression for uploads. Supported: zstd (WASM), gzip
// (native CompressionStream), none. Brotli/xz are read-only legacies: NARs
// already stored with them still serve fine (bytes pass through), but new
// uploads to a cache configured with either fall back to zstd — the actual
// codec is recorded per-NAR, so narinfo output stays correct.

import { Semaphore } from '../platform';
import { initZstd, zstdCompress } from './zstd';

export { initZstd, zstdDecompress } from './zstd';

/**
 * Shared per-isolate budget for WASM zstd work. Each compress/decompress
 * holds tens of MB across the JS and WASM heaps (a 16 MiB chunk verify is
 * ~50 MB), the Emscripten heap never shrinks, and concurrent requests
 * multiplexed over one HTTP/2 connection land on the same isolate —
 * ungated, a large push exceeds the 128 MiB isolate limit and dies as a
 * Cloudflare 1101/1102. Every heavy call site acquires one slot: chunk
 * verify, chunk and whole-NAR compression, pull-through decompression.
 */
export const wasmMemorySlots = new Semaphore(2);
export {
	extensionFor,
	uploadCompressionFor,
	validateCompressionConfig,
	type CompressionKind
} from './config';
import type { CompressionKind } from './config';

/** R2 multipart requires all non-final parts to be exactly the same size. */
export const TARGET_PART_SIZE = 8 * 1024 * 1024;
/** zstd streams are compressed in independent frames of this much input. */
const ZSTD_BLOCK_SIZE = 4 * 1024 * 1024;

/** Incremental compressor: feed chunks, collect output, then finish. */
export interface Compressor {
	transform(chunk: Uint8Array): Promise<Uint8Array[]>;
	finish(): Promise<Uint8Array[]>;
}

class NoneCompressor implements Compressor {
	async transform(chunk: Uint8Array): Promise<Uint8Array[]> {
		return [chunk];
	}
	async finish(): Promise<Uint8Array[]> {
		return [];
	}
}

/** Buffers input into 4MB blocks, emitting one independent zstd frame each. */
class ZstdCompressor implements Compressor {
	private buffer: Uint8Array[] = [];
	private buffered = 0;

	async transform(chunk: Uint8Array): Promise<Uint8Array[]> {
		this.buffer.push(chunk);
		this.buffered += chunk.length;
		const out: Uint8Array[] = [];
		while (this.buffered >= ZSTD_BLOCK_SIZE) {
			out.push(zstdCompress(this.takeBlock(ZSTD_BLOCK_SIZE)));
		}
		return out;
	}

	async finish(): Promise<Uint8Array[]> {
		if (this.buffered === 0) return [];
		return [zstdCompress(this.takeBlock(this.buffered))];
	}

	private takeBlock(size: number): Uint8Array {
		const block = new Uint8Array(size);
		let offset = 0;
		while (offset < size) {
			const head = this.buffer[0];
			const take = Math.min(head.length, size - offset);
			block.set(head.subarray(0, take), offset);
			offset += take;
			if (take === head.length) this.buffer.shift();
			else this.buffer[0] = head.subarray(take);
		}
		this.buffered -= size;
		return block;
	}
}

/** Wraps the native CompressionStream, draining output as it becomes available. */
class GzipCompressor implements Compressor {
	private writer: WritableStreamDefaultWriter<BufferSource>;
	private collected: Uint8Array[] = [];
	private pump: Promise<void>;

	constructor() {
		const stream = new CompressionStream('gzip');
		this.writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();
		this.pump = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				if (value) this.collected.push(value);
			}
		})();
	}

	async transform(chunk: Uint8Array): Promise<Uint8Array[]> {
		await this.writer.write(chunk as unknown as BufferSource);
		return this.collected.splice(0);
	}

	async finish(): Promise<Uint8Array[]> {
		await this.writer.close();
		await this.pump;
		return this.collected.splice(0);
	}
}

export async function makeCompressor(kind: CompressionKind): Promise<Compressor> {
	switch (kind) {
		case 'none':
			return new NoneCompressor();
		case 'gzip':
			return new GzipCompressor();
		case 'zstd':
			await initZstd();
			return new ZstdCompressor();
	}
}

/** Accumulates compressor output into exact TARGET_PART_SIZE parts. */
export class PartCollector {
	private buffer: Uint8Array[] = [];
	private buffered = 0;

	add(chunk: Uint8Array): Uint8Array[] {
		if (chunk.length === 0) return [];
		this.buffer.push(chunk);
		this.buffered += chunk.length;
		const parts: Uint8Array[] = [];
		while (this.buffered >= TARGET_PART_SIZE) {
			parts.push(this.take(TARGET_PART_SIZE));
		}
		return parts;
	}

	/** Remaining data as final parts (each ≤ TARGET_PART_SIZE, only last may be short). */
	flush(): Uint8Array[] {
		const parts: Uint8Array[] = [];
		while (this.buffered > 0) {
			parts.push(this.take(Math.min(this.buffered, TARGET_PART_SIZE)));
		}
		return parts;
	}

	private take(size: number): Uint8Array {
		const part = new Uint8Array(size);
		let offset = 0;
		while (offset < size) {
			const head = this.buffer[0];
			const take = Math.min(head.length, size - offset);
			part.set(head.subarray(0, take), offset);
			offset += take;
			if (take === head.length) this.buffer.shift();
			else this.buffer[0] = head.subarray(take);
		}
		this.buffered -= size;
		return part;
	}
}

export interface BufferedCompressionResult {
	data: Uint8Array;
	/** sha256 hex of the raw input. */
	narHash: string;
	narSize: number;
	/** sha256 hex of the compressed output. */
	fileHash: string;
	fileSize: number;
	kind: CompressionKind;
}

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One-shot compression with dual hashing, for buffered (≤16MB) inputs. */
export async function compressBuffer(
	input: Uint8Array,
	kind: CompressionKind
): Promise<BufferedCompressionResult> {
	const narHash = toHex(await crypto.subtle.digest('SHA-256', input as BufferSource));

	let data: Uint8Array;
	if (kind === 'none') {
		data = input;
	} else if (kind === 'zstd') {
		// The whole input is in hand: one frame, so matches span the full
		// buffer instead of stopping at the streaming path's block boundaries.
		await initZstd();
		data = zstdCompress(input);
	} else {
		const compressor = await makeCompressor(kind);
		const parts = [...(await compressor.transform(input)), ...(await compressor.finish())];
		const total = parts.reduce((n, p) => n + p.length, 0);
		data = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) {
			data.set(part, offset);
			offset += part.length;
		}
	}

	const fileHash = toHex(await crypto.subtle.digest('SHA-256', data as BufferSource));
	return { data, narHash, narSize: input.length, fileHash, fileSize: data.length, kind };
}
