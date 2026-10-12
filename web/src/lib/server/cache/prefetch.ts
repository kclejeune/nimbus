/** Ordered, request-local read-ahead. Only load headers/resources ahead;
 * buffering their bytes remains the consumer's memory-budget obligation.
 * The yielded resource and every unused load are disposed on early exit. */
export async function* prefetchInOrder<I, T>(
	items: readonly I[],
	ahead: number,
	load: (item: I) => Promise<T>,
	dispose: (value: T) => Promise<unknown>,
	defer?: (cleanup: Promise<unknown>) => void
): AsyncGenerator<T> {
	if (!Number.isInteger(ahead) || ahead < 1) throw new RangeError('Read-ahead must be positive');
	const pending: Promise<T>[] = [];
	let next = 0;
	const fill = () => {
		while (next < items.length && pending.length < ahead) {
			const work = load(items[next++]);
			work.catch(() => {});
			pending.push(work);
		}
	};
	try {
		fill();
		while (pending.length) {
			const value = await pending.shift()!;
			try {
				fill();
				yield value;
			} finally {
				await dispose(value);
			}
		}
	} finally {
		if (pending.length) {
			const cleanup = Promise.allSettled(pending.map(async (work) => dispose(await work)));
			// An unused fetch may still be waiting on storage headers. Its
			// request-local cleanup need not delay an already decided failure.
			if (defer) defer(cleanup);
			else await cleanup;
		}
	}
}
