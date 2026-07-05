// zstd via the vendored Emscripten build (proven on Workers in the Rust
// worker deployment). Import order matters: zstd-setup installs the WASM
// loader before the Emscripten glue evaluates.

import './zstd-setup';
import { Module, waitInitialized } from './zstd-lib/module.js';
import { compress as zstdCompressRaw } from './zstd-lib/simple/compress.js';

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

export const ZSTD_LEVEL = 3;

/** Compress bytes as a single zstd frame. Call initZstd() first. */
export function zstdCompress(data: Uint8Array, level = ZSTD_LEVEL): Uint8Array {
	return zstdCompressRaw(data, level);
}
