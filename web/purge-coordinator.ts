import { processChunkRepair } from './src/lib/server/cache/repair';
import { DurableObject } from 'cloudflare:workers';
import { PurgeQueue } from './src/lib/server/cache/purge-queue';
import type { ExecutionContext } from './src/lib/server/cache/platform';

/** One named instance per Worker. Raw purges must run in CachedStore, since
 * only that entrypoint owns the cached responses we need to invalidate. */
export class PurgeCoordinator extends DurableObject<App.Platform['env']> {
	private queue: PurgeQueue = new PurgeQueue(
		this.ctx.storage,
		(tags) => (this.ctx as unknown as ExecutionContext).exports!.CachedStore!.purgeBatch(tags),
		(key) =>
			processChunkRepair(this.env, key, (tags, receipt) =>
				this.queue.repairPurge(key, receipt, tags)
			)
	);
	enqueue(tags: string[], urgent = false) {
		return this.queue.enqueue(tags, urgent);
	}
	scheduleRepair(key: string) {
		return this.queue.scheduleRepair(key);
	}
	alarm() {
		return this.queue.alarm();
	}
}
