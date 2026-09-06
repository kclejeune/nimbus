// Cloudflare Workers runtime touchpoints used by the cache engine, gathered
// here so the platform coupling is explicit. Everything else in this module
// is standard Web APIs plus the D1/R2 bindings typed via App.Platform; the
// remaining CF-specific piece is compression/zstd-setup.ts, whose .wasm
// import only wrangler's bundler understands.
import { bodyDeadline, readWithTimeout } from '../request-body';

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

/** A timer is a request's own I/O and thus the only context-safe wait on
 * Workers (see Semaphore below); every delay in this package routes through
 * here so that invariant has one home. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
			await sleep(backoff + Math.random() * backoff);
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
	private waiters = 0;
	constructor(slots: number) {
		this.free = slots;
	}
	tryAcquire(): boolean {
		if (this.free <= 0) return false;
		this.free--;
		return true;
	}
	/** Queue without buffering request bodies, but cap both queue length and
	 * wait. Waiters hold no memory, so the queue is sized for a whole client
	 * fan-out (the Go pusher sends up to 40 concurrent requests over one
	 * HTTP/2 connection, all landing on this isolate) rather than for the
	 * slot count; a refusal costs the client one of its three retries. */
	async acquireBounded(maxWaiters = 64, timeoutMs = 120_000): Promise<boolean> {
		if (this.tryAcquire()) return true;
		if (this.waiters >= maxWaiters) return false;
		this.waiters++;
		const deadline = Date.now() + timeoutMs;
		let interval = 5;
		try {
			while (Date.now() < deadline) {
				await sleep(Math.min(interval + Math.random() * interval, deadline - Date.now()));
				if (this.tryAcquire()) return true;
				interval = Math.min(interval * 2, 40);
			}
			return false;
		} finally {
			this.waiters--;
		}
	}
	async acquire(): Promise<void> {
		// Adaptive interval: a handoff is noticed within ~5-10 ms while
		// sustained contention backs off toward a steady ~40-80 ms.
		let interval = 5;
		while (this.free <= 0) {
			await sleep(interval + Math.random() * interval);
			interval = Math.min(interval * 2, 40);
		}
		this.free--;
	}
	release(): void {
		this.free++;
	}
}

// Covers input buffering through R2 persistence, not just the WASM call.
// Two slots match wasmMemorySlots: each admitted upload holds at most one raw
// chunk (≤16 MiB) plus its compressed form, and the WASM heap is shared, so
// two pipelines fit the 128 MiB isolate with the same margin the WASM gate
// alone had. Body-carrying uploads queue via acquireBounded; speculative
// ingestion takes a short bounded wait and otherwise yields.
export const uploadMemory = new Semaphore(2);

/** Run fn while holding one slot of sem. */
export async function withSlot<T>(sem: Semaphore, fn: () => Promise<T> | T): Promise<T> {
	await sem.acquire();
	try {
		return await fn();
	} finally {
		sem.release();
	}
}

/**
 * Map items with bounded concurrency and rolling admission: a finished task
 * immediately admits the next item, unlike fixed Promise.all batches where the
 * slowest member stalls its whole batch (with heterogeneous latencies — e.g.
 * upstream probes racing a 5s timeout — that sync tax is the difference).
 * Results keep input order. A rejection stops the admission of new items and
 * propagates after the in-flight tasks settle; callers whose fn never throws
 * (the probe paths) see every result.
 */
export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let stopped = false;
	const worker = async () => {
		while (!stopped) {
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i], i);
			} catch (e) {
				stopped = true;
				throw e;
			}
		}
	};
	const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
	const settled = await Promise.allSettled(workers);
	const failed = settled.find((s) => s.status === 'rejected');
	if (failed) throw failed.reason;
	return results;
}

/** Collect a stream into memory, or null once it exceeds `limit` bytes. */
export async function readAll(
	body: ReadableStream<Uint8Array>,
	limit: number
): Promise<Uint8Array | null> {
	const parts: Uint8Array[] = [];
	let total = 0;
	const reader = body.getReader();
	const deadline = bodyDeadline();
	for (;;) {
		const { done, value } = await readWithTimeout(reader, deadline);
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
