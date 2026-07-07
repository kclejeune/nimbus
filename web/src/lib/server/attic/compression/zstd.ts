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

// Level 12 measured ~13% smaller than 3 on real NARs at ~1s/50MB native
// (wasm ~3-5x slower) — comfortably inside the request CPU budget for
// ≤16 MiB inputs. 19 would save another ~10% but risks the CPU ceiling.
export const ZSTD_LEVEL = 12;

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
