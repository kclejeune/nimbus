// Cloudflare Workers runtime touchpoints used by the cache engine, gathered
// here so the platform coupling is explicit. Everything else in this module
// is standard Web APIs plus the D1/R2 bindings typed via App.Platform; the
// remaining CF-specific piece is compression/zstd-setup.ts, whose .wasm
// import only wrangler's bundler understands.

/**
 * Execution context extended with the loopback bindings for the entrypoints
 * exported from worker-entry.ts; @cloudflare/workers-types does not model
 * ctx.exports yet.
 */
export type ExecutionContext = App.Platform['ctx'] & {
	exports?: {
		CachedStore?: {
			fetch(request: Request): Promise<Response>;
			purgeTags(tags: string[]): Promise<void>;
		};
	};
};

/** crypto.DigestStream is a Workers-runtime extension absent from DOM types. */
export interface DigestStreamLike extends WritableStream<BufferSource> {
	readonly digest: Promise<ArrayBuffer>;
}

/** Streaming SHA-256 without JS-side hashing cost. */
export function newDigestStream(): DigestStreamLike {
	const workersCrypto = crypto as unknown as {
		DigestStream: new (algorithm: string) => DigestStreamLike;
	};
	return new workersCrypto.DigestStream('SHA-256');
}
