import { AsyncMemo } from './async-memo';
import { countMetadataRead } from './latency';
import { settled, valueOf, type Result } from './result';
import { isStoreRecoveryBypassed } from './store-transport';

const NO_TTL = () => 0;

/** Share only the result of overlapping reads, never a request's I/O promise
 * or a value cached beyond the fill. A failed fill is also a completed result:
 * its existing waiters fail together instead of each retrying D1 in turn.
 * The lease exceeds the multi-second D1 stalls seen in production, but an
 * abandoned request cannot prevent another caller from making progress. */
export class ReadCoalescer<T> {
	private readonly fills = new AsyncMemo<Result<T>>(0, 1_000, 15_000);

	/** Clearing a key makes its waiters reload rather than share the fill. */
	clear(key?: string): void {
		this.fills.clear(key);
	}

	async get(key: string, load: () => Promise<T>): Promise<T> {
		let loaded = false;
		try {
			const fill = () => {
				loaded = true;
				return settled(Promise.resolve().then(load));
			};
			// The loopback may have abandoned its leader without settling the
			// lease. Recovery reads independently instead of waiting on it again.
			if (isStoreRecoveryBypassed()) return valueOf(await fill());
			return valueOf(await this.fills.get(key, fill, NO_TTL));
		} finally {
			countMetadataRead(!loaded);
		}
	}
}
