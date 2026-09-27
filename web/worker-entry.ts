// Custom worker entry: dispatches cache-hostname traffic to the binary-cache
// API, everything else to the SvelteKit worker, and adds the
// scheduled handler for nightly garbage collection. wrangler.jsonc points
// `main` here; the SvelteKit bundle must be built (vite build) first.
//
// Two reasons this lives outside src/ and outside SvelteKit routing:
// - importing the generated (untyped) .svelte-kit/cloudflare/_worker.js from
//   the svelte-check project would pull the whole bundle into type checking;
// - the attic API imports zstd.wasm, which only wrangler's bundler handles
//   (CompiledWasm) — Vite must never see it, so the dispatch cannot go
//   through hooks.server.ts. The adapter emits to .svelte-kit/cloudflare via
//   wrangler.adapter.jsonc, so this file is never overwritten by builds.

import { processChunkRepair, replayChunkRepairs } from './src/lib/server/cache/repair';
import {
	purgeWithJournal,
	replayPurges,
	journalPurge,
	PurgeRateLimitedError,
	PurgeDeferredError
} from './src/lib/server/cache/purge';
import { withRequestSpan, withSpan } from './src/lib/server/cache/tracing';
import { observeRequest, routeTemplate } from './src/lib/server/cache/latency';
import { WorkerEntrypoint } from 'cloudflare:workers';
import sveltekit from './.svelte-kit/cloudflare/_worker.js';
import { runGc } from './src/lib/server/cache/gc';
import { caughtResponse, handleCacheApi } from './src/lib/server/cache/router';
import { serveStore } from './src/lib/server/cache/store';

export { PurgeCoordinator } from './purge-coordinator';

type Env = App.Platform['env'];

/** An urgent purge only succeeds once eviction is confirmed; queued work that
 * is not yet confirmed must not be reported as done. */
function confirmedOrDeferred(result: { confirmed: boolean }, urgent: boolean) {
	if (urgent && !result.confirmed) throw new PurgeDeferredError();
	return result;
}

/**
 * Read path of the binary-cache API behind Workers Caching (see the `cache`
 * and `exports` blocks in wrangler.jsonc): narinfo and NAR bodies with public
 * Cache-Control, cached at the edge so hits skip D1 and R2 entirely. Only
 * reachable through ctx.exports from the gateway below, which authorizes
 * every request first — never routed directly from the internet.
 */
export class CachedStore extends WorkerEntrypoint {
	async fetch(request: Request) {
		const route = routeTemplate(request);
		// Logged on entry, not exit: a "Worker hung" cancellation emits no
		// nimbus.latency line and traces are sampled, so without this the
		// stuck route is unknowable after the fact.
		console.log(
			JSON.stringify({ event: 'nimbus.store', route, path: new URL(request.url).pathname })
		);
		return withRequestSpan(this.ctx, route, 'store', () =>
			observeRequest(
				request,
				this.env as Env,
				'store',
				async () => {
					try {
						return await serveStore(request, this.env as Env, this.ctx as App.Platform['ctx']);
					} catch (e) {
						return caughtResponse('store read unhandled', request, e);
					}
				},
				route
			)
		);
	}

	/**
	 * Purge cached responses by Cache-Tag. Purges only affect the cache of the
	 * entrypoint that issues them, so GC must call in here over the loopback —
	 * a purge from the gateway would target the gateway's (disabled) cache.
	 */
	async purgeTags(tags: string[]) {
		await this.observePurge('rpc', tags.length, () =>
			withSpan(this.ctx, 'store purgeTags', () => this.coordinatePurge(tags, true))
		);
	}

	/** Uploads and routine GC only require durable acceptance. Trust mutations
	 * use purgeTags; repairs use durable page receipts and alarm continuation. */
	async enqueuePurgeTags(tags: string[]) {
		return this.coordinatePurge(tags, false);
	}

	/** The singleton purge queue, when this deployment binds one. */
	private coordinator() {
		return (this.env as Env).PURGE_COORDINATOR?.getByName('cache-purges');
	}

	private async coordinatePurge(tags: string[], urgent: boolean) {
		const env = this.env as Env;
		const coordinator = this.coordinator();
		if (!coordinator) {
			await purgeWithJournal(env, tags, (batch) => this.purge(batch));
			return { confirmed: true };
		}
		let result: { confirmed: boolean };
		try {
			result = await coordinator.enqueue(tags, urgent);
		} catch (error) {
			// Keep the legacy journal as a transport-failure safety net. Cron transfers
			// it to the durable queue before deleting any R2 obligations.
			await journalPurge(env, tags);
			throw error;
		}
		return confirmedOrDeferred(result, urgent);
	}

	/** coordinatePurge without the R2 journal fallback, for callers that already
	 * hold their own retry record (a replayed journal entry, a chunk_repair row):
	 * journaling their failures would duplicate that record on every cron run. */
	private async purgeUnjournaled(tags: string[], urgent: boolean) {
		const coordinator = this.coordinator();
		if (!coordinator) return this.purge(tags);
		confirmedOrDeferred(await coordinator.enqueue(tags, urgent), urgent);
	}

	/** Called only by the singleton coordinator. Return the rejection category
	 * as data across RPC so a rate limit schedules recovery, not retries. */
	async purgeBatch(tags: string[]) {
		try {
			await this.purge(tags);
			return { success: true };
		} catch (error) {
			return { success: false, rateLimited: error instanceof PurgeRateLimitedError };
		}
	}

	private async observePurge<T>(operation: string, tagCount: number, run: () => Promise<T>) {
		const operationId = crypto.randomUUID();
		const started = Date.now();
		const log = (phase: string) =>
			console.log(
				JSON.stringify({
					event: 'nimbus.purge',
					operation,
					operationId,
					tagCount,
					phase,
					ms: Date.now() - started
				})
			);
		// Entry logs survive cancellations that never reach catch/finally.
		log('start');
		try {
			const result = await run();
			log('ok');
			return result;
		} catch (error) {
			log('error');
			throw error;
		}
	}

	async processChunkRepair(key: string) {
		const coordinator = this.coordinator();
		if (coordinator) await coordinator.scheduleRepair(key);
		else
			await processChunkRepair(this.env as Env, key, (tags) => this.purgeUnjournaled(tags, true));
	}

	/** Replay both durable journals: pending cache purges, then chunk repairs. */
	async replayJournals() {
		try {
			await replayPurges(this.env as Env, (tags) => this.purgeUnjournaled(tags, false));
		} finally {
			await replayChunkRepairs(this.env as Env, (key) => this.processChunkRepair(key));
		}
	}

	private async purge(tags: string[]) {
		const cache = (
			this.ctx as {
				cache?: {
					purge(opts: {
						tags: string[];
					}): Promise<{ success: boolean; errors: { code: number; message: string }[] }>;
				};
			}
		).cache;
		if (!cache) throw new Error('ctx.cache unavailable');
		await this.observePurge('cache', tags.length, async () => {
			const result = await cache.purge({ tags });
			if (!result.success) {
				const message = `Cache purge rejected: ${JSON.stringify(result.errors)}`;
				throw result.errors.some((e) => e.code === 1134)
					? new PurgeRateLimitedError(message)
					: new Error(message);
			}
		});
	}
}

/** Whether the request is addressed to the binary-cache hostname. */
function isCacheHost(request: Request, cacheBaseUrl?: string): boolean {
	if (!cacheBaseUrl) return false;
	const cacheHost = new URL(cacheBaseUrl).host;
	// The Host header can be rewritten by local dev proxies, so accept a match
	// on either the URL host or the raw header.
	return new URL(request.url).host === cacheHost || request.headers.get('host') === cacheHost;
}

export default {
	async fetch(request: Request, env: Env, ctx: unknown) {
		if (isCacheHost(request, env.CACHE_BASE_URL)) {
			const route = routeTemplate(request);
			return withRequestSpan(ctx, route, 'gateway', () =>
				handleCacheApi(request, env, ctx as App.Platform['ctx'], route)
			);
		}
		return sveltekit.fetch(request, env, ctx);
	},

	async scheduled(_controller: unknown, env: Env, ctx: unknown) {
		// Upstream re-validation is not cron work: passthrough narinfos carry
		// the upstream's TTL as edge max-age (the CDN re-invokes the worker on
		// expiry) and D1 "present" verdicts lazily expire on the same TTL.
		try {
			await (
				ctx as import('./src/lib/server/cache/platform').ExecutionContext
			).exports?.CachedStore?.replayJournals();
		} catch (e) {
			console.warn('journal replay failed', e);
		}
		const stats = await runGc(env, { ctx: ctx as App.Platform['ctx'] });
		console.log(`gc: ${JSON.stringify(stats)}`);
		// Refresh D1 query-planner statistics after GC changes row counts. Without
		// stats SQLite mis-plans the hot lookups — the download-touch and narinfo
		// serve queries chose idx_nar_state (every valid nar, ~28k rows/call) over
		// the selective nar_hash index, reading ~825M rows/day and overloading D1
		// under CI read bursts. The composite idx_nar_hash_state now makes those
		// plans statistics-independent; ANALYZE stays for every other query.
		try {
			await env.ATTIC_DB.exec('ANALYZE');
			console.log('analyze: refreshed D1 planner statistics');
		} catch (e) {
			console.warn(`analyze: failed to refresh statistics: ${e}`);
		}
	}
};
