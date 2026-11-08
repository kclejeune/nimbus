import type { MemoryBudget } from './platform';

export type UploadMemoryState = ReturnType<MemoryBudget['snapshot']> & {
	isolate: string;
	prefetchBytes: number;
	prefetchActive: number;
};

export interface UploadChunk {
	narHash: string;
	index: number;
	chunkHash: string;
	rawBytes: number;
	expectedBytes?: number;
	prefetched?: boolean;
}

const SLOW_MS = 1_000;
const PENDING_MS = 5_000;
const PROGRESS_MS = 15_000;

/** Fast chunks keep their existing spans. Slow or failed operations also log
 * independently of trace sampling; pending logs survive abandoned requests.
 * Only the operation's own timer and byte counts are observed. */
export async function observeUploadChunk<T>(
	phase: 'get' | 'body',
	chunk: UploadChunk,
	memory: () => UploadMemoryState,
	work: (progress: (bytes: number) => void) => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	const started = performance.now();
	let progressed = started;
	let bytes = 0;
	const emit = (status: string, error?: unknown) => {
		const now = performance.now();
		const log = status === 'error' ? console.warn : console.log;
		log(
			JSON.stringify({
				event: 'nimbus.upload_chunk',
				phase,
				status,
				...chunk,
				ms: now - started,
				bytes,
				idleMs: now - progressed,
				memory: memory(),
				error:
					error === undefined ? undefined : error instanceof Error ? error.message : String(error)
			})
		);
	};
	let timer: ReturnType<typeof setTimeout>;
	const pending = () => {
		emit('pending');
		timer = setTimeout(pending, PROGRESS_MS);
	};
	timer = setTimeout(pending, PENDING_MS);
	try {
		const result = await work((total) => {
			bytes = total;
			progressed = performance.now();
		});
		if (result === null) emit(phase === 'get' ? 'missing' : 'invalid');
		else if (performance.now() - started >= SLOW_MS) emit('ok');
		return result;
	} catch (error) {
		emit(signal?.aborted ? 'cancelled' : 'error', error);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
