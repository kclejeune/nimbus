// zstd via the vendored Emscripten build (proven on Workers in the Rust
// worker deployment). Import order matters: zstd-setup installs the WASM
// loader before the Emscripten glue evaluates.

import './zstd-setup';
import { Module, waitInitialized } from './zstd-lib/module.js';
import { compress as zstdCompressRaw } from './zstd-lib/simple/compress.js';
import { decompress as zstdDecompressRaw } from './zstd-lib/simple/decompress.js';

let initialized: Promise<void> | null = null;

export function initZstd(): Promise<void> {
	if (!initialized) {
		initialized = (async () => {
			Module.init('');
			await waitInitialized();
		})();
	}
	return initialized;
}

// Level 9 keeps most of level 12's ratio (12 measured ~13% smaller than 3 on
// real NARs; 9 gives up ~1-2% of that) at roughly half the CPU. That matters
// here because WASM runs ~3-5x slower than native and a streaming 100 MB
// upload compresses ~12 chunks in one invocation: level 12's ~1-1.6s per
// 16 MiB chunk stacked up to 12-20s of CPU per push.
export const ZSTD_LEVEL = 9;

/** Compress bytes as a single zstd frame. Call initZstd() first. */
export function zstdCompress(data: Uint8Array, level = ZSTD_LEVEL): Uint8Array {
	return zstdCompressRaw(data, level);
}

/**
 * Decompress a sequence of complete zstd frames, failing on trailing garbage
 * or content larger than maxSize (the zstd-bomb guard). Call initZstd() first.
 */
export function zstdDecompress(data: Uint8Array, maxSize: number): Uint8Array {
	return zstdDecompressRaw(data, maxSize);
}
