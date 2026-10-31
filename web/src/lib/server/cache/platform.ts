// Cloudflare Workers runtime touchpoints used by the cache engine, gathered
// here so the platform coupling is explicit. Everything else in this module
// is standard Web APIs plus the D1/R2 bindings typed via App.Platform; the
// remaining CF-specific piece is compression/zstd-setup.ts, whose .wasm
// import only wrangler's bundler understands.
import type { PurgeResult } from './purge-queue';
import { countR2, countRetry, measure } from './latency';
import { bodyDeadline, bodyWatchdog } from '../request-body';

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
			purgePathPage?(id: string, receipt: string, tags: string[]): Promise<boolean>;
			enqueuePurgeTags(tags: string[]): Promise<{ confirmed: boolean }>;
			/** Raw eviction for the purge coordinator; never throws. */
			purgeBatch(tags: string[]): Promise<PurgeResult>;
			replayJournals(): Promise<void>;
			processChunkRepair(key: string): Promise<void>;
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

/** Workers ignores a manually set Content-Length on an ordinary stream.
 * FixedLengthStream sets the wire length and rejects short/long writes. */
export function newFixedLengthStream(size: number): TransformStream<Uint8Array, Uint8Array> {
	const runtime = globalThis as unknown as {
		FixedLengthStream: new (size: number) => TransformStream<Uint8Array, Uint8Array>;
	};
	return new runtime.FixedLengthStream(size);
}

/** A timer is a request's own I/O and thus the only context-safe wait on
 * Workers (see Semaphore below); every delay in this package routes through
 * here so that invariant has one home. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `work`'s value, or undefined once `ms` passes first. The timer is always
 * cleared; a late `work` keeps running and is the caller's to park. */
export async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
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
			countRetry();
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
export const withR2Retry = <T>(op: () => Promise<T>): Promise<T> =>
	measure('r2', () =>
		withRetry(() => {
			countR2();
			return op();
		})
	);

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

/**
 * A byte budget with a concurrency cap, polled like Semaphore (same I/O
 * context constraint). Admission is FIFO among waiters: only the oldest may
 * take budget, and nobody jumps a non-empty queue, so a full-slot upload
 * cannot be starved by a stream of light ones that each fit the remainder.
 */
export class MemoryBudget {
	private freeBytes: number;
	private active = 0;
	// Waiting callers, oldest first. A waiter removes itself when it gives up,
	// but a request canceled on client disconnect never resumes to do so —
	// its finally does not run — so callers also drop an expired head, and a
	// dead waiter blocks the queue for at most its own timeout.
	private readonly queue: { deadline: number }[] = [];
	constructor(
		totalBytes: number,
		private readonly maxActive: number
	) {
		this.freeBytes = totalBytes;
	}
	private fits(weight: number): boolean {
		return this.active < this.maxActive && weight <= this.freeBytes;
	}
	private take(weight: number): void {
		this.freeBytes -= weight;
		this.active++;
	}
	private dropExpiredHead(): void {
		const now = Date.now();
		while (this.queue.length > 0 && this.queue[0].deadline <= now) this.queue.shift();
	}
	/** Take budget now or not at all; never ahead of a waiter. */
	tryAcquire(weight: number): boolean {
		this.dropExpiredHead();
		if (this.queue.length > 0 || !this.fits(weight)) return false;
		this.take(weight);
		return true;
	}
	/** Queue without buffering request bodies, but cap both queue length and
	 * wait. Waiters hold no memory, so the queue is sized for a whole client
	 * fan-out (the Go pusher sends up to 40 concurrent requests over one
	 * HTTP/2 connection, all landing on this isolate) rather than for the
	 * active count; a refusal costs the client one of its three retries. */
	async acquireBounded(weight: number, maxWaiters: number, timeoutMs: number): Promise<boolean> {
		if (this.tryAcquire(weight)) return true;
		if (this.queue.length >= maxWaiters) return false;
		const deadline = Date.now() + timeoutMs;
		const waiter = { deadline };
		this.queue.push(waiter);
		let interval = 5;
		try {
			while (Date.now() < deadline) {
				await sleep(Math.min(interval + Math.random() * interval, deadline - Date.now()));
				this.dropExpiredHead();
				if (this.queue[0] === waiter && this.fits(weight)) {
					this.take(weight);
					return true;
				}
				interval = Math.min(interval * 2, 40);
			}
			return false;
		} finally {
			const index = this.queue.indexOf(waiter);
			if (index >= 0) this.queue.splice(index, 1);
		}
	}
	release(weight: number): void {
		this.freeBytes += weight;
		this.active--;
	}
	/** Return bytes after a pipeline drops its raw buffer, retaining its
	 * active-request slot and the FIFO order of existing waiters. */
	shrink(oldWeight: number, newWeight: number): void {
		if (!Number.isFinite(newWeight) || newWeight < 0 || newWeight > oldWeight)
			throw new RangeError('Memory weight must shrink');
		this.freeBytes += oldWeight - newWeight;
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

/** Read native byte streams into one buffer without copying fragments in
 * JavaScript. BYOB transfers the buffer, so every read must recover it from
 * the returned view, including an empty EOF read. Incorrect size hints
 * still grow or trim the result, and a separate read verifies EOF at the
 * limit rather than trusting Content-Length. */
interface BodyOptions {
	signal?: AbortSignal;
	/** Trusted storage reads, not client uploads: batch native fragments. */
	batch?: boolean;
}

/** Minimum bytes per native batched read (workerd's `readAtLeast`). */
export const BODY_READ_BYTES = 64 * 1024;
export type BatchReader = ReadableStreamBYOBReader & {
	readAtLeast(
		min: number,
		view: Uint8Array
	): Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>;
};

async function readSizedBody(
	reader: ReadableStreamBYOBReader,
	limit: number,
	size: number,
	options: BodyOptions
): Promise<Uint8Array | null> {
	let out = new Uint8Array(size);
	let total = 0;
	let view: Uint8Array<ArrayBuffer>;
	const watchdog = bodyWatchdog(reader, bodyDeadline(), options.signal);
	const batch = options.batch ? (reader as Partial<BatchReader>).readAtLeast : undefined;
	try {
		for (;;) {
			const capacity = out.length;
			const intoOutput = total < capacity;
			// Past the hint, a 1-byte probe confirms EOF; any byte it finds
			// grows `out` and later reads land there directly.
			view = intoOutput ? out.subarray(total) : new Uint8Array(1);
			const { done, value } = await watchdog.read(() =>
				batch
					? batch.call(reader, Math.min(BODY_READ_BYTES, view.byteLength), view)
					: reader.read(view)
			);
			if (intoOutput) {
				if (!value) throw new Error('Body read cancelled');
				out = new Uint8Array(value.buffer, 0, capacity);
			}
			if (done) break;
			if (!value || value.length === 0) continue;
			const offset = total;
			total += value.length;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				return null;
			}
			if (!intoOutput) {
				const grown = new Uint8Array(Math.min(limit, Math.max(total, capacity * 2)));
				grown.set(out);
				grown.set(value, offset);
				out = grown;
			}
		}
	} finally {
		watchdog.close();
		reader.releaseLock();
	}
	// Trim an inaccurate hint so upload admission can account for the actual
	// backing allocation, rather than a short view retaining a large buffer.
	return out.length === total ? out : out.slice(0, total);
}

/** Collect a stream, or null once it exceeds `limit`. A known size uses
 * direct native BYOB reads where supported, with a preallocated-buffer
 * fallback for ordinary streams (the upload preamble split's remainder).
 * The size is only an allocation hint;
 * byte limits and read deadlines still apply independently. */
export async function readAll(
	body: ReadableStream<Uint8Array>,
	limit: number,
	expectedSize?: number,
	options: BodyOptions = {}
): Promise<Uint8Array | null> {
	const sized =
		expectedSize !== undefined &&
		Number.isSafeInteger(expectedSize) &&
		expectedSize >= 0 &&
		expectedSize <= limit;
	if (sized) {
		let byob: ReadableStreamBYOBReader | undefined;
		try {
			byob = body.getReader({ mode: 'byob' });
		} catch {
			// User-created streams and Node test fixtures may not be byte streams.
		}
		if (byob) return readSizedBody(byob, limit, expectedSize!, options);
	}
	const parts: Uint8Array[] = [];
	let out = sized ? new Uint8Array(expectedSize!) : undefined;
	let total = 0;
	const reader = body.getReader();
	const watchdog = bodyWatchdog(reader, bodyDeadline(), options.signal);
	try {
		for (;;) {
			const { done, value } = await watchdog.read(() => reader.read());
			if (done) break;
			if (!value || value.length === 0) continue;
			const offset = total;
			total += value.length;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				return null;
			}
			if (out) {
				if (total > out.length) {
					const grown = new Uint8Array(Math.min(limit, Math.max(total, out.length * 2)));
					grown.set(out);
					out = grown;
				}
				out.set(value, offset);
			} else parts.push(value);
		}
	} finally {
		watchdog.close();
		reader.releaseLock();
	}
	if (out) return out.length === total ? out : out.slice(0, total);
	out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
