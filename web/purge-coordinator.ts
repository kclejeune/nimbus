import { processChunkRepair } from './src/lib/server/cache/repair';
import { processPathPurge } from './src/lib/server/cache/closure-purge';
import { DurableObject } from 'cloudflare:workers';
import { PurgeQueue } from './src/lib/server/cache/purge-queue';
import type { ExecutionContext } from './src/lib/server/cache/platform';
import { readRpcResult } from './src/lib/server/cache/rpc';

/** One named instance per Worker. Raw purges must run in CachedStore, since
 * only that entrypoint owns the cached responses we need to invalidate. */
export class PurgeCoordinator extends DurableObject<App.Platform['env']> {
	private queue: PurgeQueue = new PurgeQueue(
		this.ctx.storage,
		async (tags) =>
			readRpcResult(
				await (this.ctx as unknown as ExecutionContext).exports!.CachedStore!.purgeBatch(tags),
				({ success, rateLimited }) => ({ success, rateLimited })
			),
		(key) =>
			key.startsWith('path-purge:')
				? processPathPurge(this.env, key.slice('path-purge:'.length), (tags, receipt) =>
						this.queue.repairPurge(key, receipt, tags, true)
					)
				: processChunkRepair(this.env, key, (tags, receipt) =>
						this.queue.repairPurge(key, receipt, tags)
					)
	);
	enqueue(tags: string[], urgent = false) {
		return this.queue.enqueue(tags, urgent);
	}
	scheduleRepair(key: string) {
		return this.queue.scheduleRepair(key);
	}
	pathPurge(id: string, receipt: string, tags: string[]) {
		return this.queue.repairPurge('path-purge:' + id, receipt, tags, true);
	}
	alarm() {
		return this.queue.alarm();
	}
}
