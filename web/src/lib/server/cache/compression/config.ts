// Compression policy, kept free of WASM imports so Vite-bundled admin code
// (cache-config) can use it — the encoder in ./index.ts pulls in zstd.wasm,
// which only the wrangler bundle can handle.

export type CompressionKind = 'zstd' | 'gzip' | 'none';

export function extensionFor(kind: CompressionKind): string {
	switch (kind) {
		case 'zstd':
			return '.zst';
		case 'gzip':
			return '.gz';
		case 'none':
			return '';
	}
}

/** Codec actually used for new uploads given a cache's configured compression. */
export function uploadCompressionFor(configured: string): CompressionKind {
	switch (configured) {
		case 'gzip':
		case 'gz':
			return 'gzip';
		case 'none':
			return 'none';
		default:
			// zstd, plus br/xz legacies that we no longer encode.
			return 'zstd';
	}
}

/** Compression values accepted for cache configuration. */
export function validateCompressionConfig(value: string): string | null {
	const normalized = value === 'gz' ? 'gzip' : value;
	return ['zstd', 'gzip', 'none'].includes(normalized) ? normalized : null;
}
