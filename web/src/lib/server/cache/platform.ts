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

/** Retry an async operation with jittered exponential backoff. shouldRetry
 * gates which failures are worth re-attempting (default: all). */
export async function withRetry<T>(
	op: () => Promise<T>,
	opts: { attempts?: number; baseMs?: number; shouldRetry?: (e: unknown) => boolean } = {}
): Promise<T> {
	const { attempts = 3, baseMs = 100, shouldRetry = () => true } = opts;
	let backoff = baseMs;
	for (let attempt = 1; ; attempt++) {
		try {
			return await op();
		} catch (e) {
			if (attempt >= attempts || !shouldRetry(e)) throw e;
			await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff));
			backoff *= 2;
		}
	}
}

/**
 * R2 flavor: retry any failure (~100/200 ms). R2 errors carry no stable
 * transience signal, and every call site is a get/put of an immutable
 * content-addressed object, so a blanket retry is safe.
 */
export const withR2Retry = <T>(op: () => Promise<T>): Promise<T> => withRetry(op);

/**
 * Minimal counting semaphore for bounding concurrent memory-heavy work
 * within an isolate. Waiters poll on their own jittered timers rather than
 * being woken by the releaser: on Workers, each request runs in its own I/O
 * context, and resolving a promise created in another request's context gets
 * the continuation canceled — the waiter then hangs with no pending I/O and
 * the runtime kills its request as hung (Cloudflare error 1101). A timer is
 * the waiting request's own I/O, so polling is the only context-safe wait.
 */
export class Semaphore {
	private free: number;
	constructor(slots: number) {
		this.free = slots;
	}
	tryAcquire(): boolean {
		if (this.free > 0) {
			this.free--;
			return true;
		}
		return false;
	}
	async acquire(): Promise<void> {
		while (!this.tryAcquire()) {
			await new Promise((r) => setTimeout(r, 25 + Math.random() * 25));
		}
	}
	release(): void {
		this.free++;
	}
}

/** Run fn while holding one slot of sem. */
export async function withSlot<T>(sem: Semaphore, fn: () => Promise<T> | T): Promise<T> {
	await sem.acquire();
	try {
		return await fn();
	} finally {
		sem.release();
	}
}

/** Collect a stream into memory, or null once it exceeds `limit` bytes. */
export async function readAll(
	body: ReadableStream<Uint8Array>,
	limit: number
): Promise<Uint8Array | null> {
	const parts: Uint8Array[] = [];
	let total = 0;
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value || value.length === 0) continue;
		total += value.length;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		parts.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
