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

import { WorkerEntrypoint } from 'cloudflare:workers';
import sveltekit from './.svelte-kit/cloudflare/_worker.js';
import { errorResponse, logUnhandled } from './src/lib/server/attic/http';
import { runGc } from './src/lib/server/cache/gc';
import { handleCacheApi } from './src/lib/server/cache/router';
import { serveStore } from './src/lib/server/cache/store';

type Env = App.Platform['env'];

/**
 * Read path of the binary-cache API behind Workers Caching (see the `cache`
 * and `exports` blocks in wrangler.jsonc): narinfo and NAR bodies with public
 * Cache-Control, cached at the edge so hits skip D1 and R2 entirely. Only
 * reachable through ctx.exports from the gateway below, which authorizes
 * every request first — never routed directly from the internet.
 */
export class CachedStore extends WorkerEntrypoint {
	async fetch(request: Request) {
		try {
			return await serveStore(request, this.env as Env, this.ctx as App.Platform['ctx']);
		} catch (e) {
			// serveNar/serveNarInfo have no internal boundary; an uncaught throw
			// here (transient D1 error, half-linked NAR) would reject the RPC and
			// surface to nix as a stackless 1101/500. Log the stack (observability
			// is on) and return a controlled 500 across the loopback instead.
			logUnhandled('store read unhandled', request, e);
			return errorResponse(500, 'Internal error reading store');
		}
	}

	/**
	 * Purge cached responses by Cache-Tag. Purges only affect the cache of the
	 * entrypoint that issues them, so GC must call in here over the loopback —
	 * a purge from the gateway would target the gateway's (disabled) cache.
	 */
	async purgeTags(tags: string[]) {
		const cache = (this.ctx as { cache?: { purge(opts: { tags: string[] }): Promise<unknown> } })
			.cache;
		if (!cache) throw new Error('ctx.cache unavailable');
		await cache.purge({ tags });
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
			return handleCacheApi(request, env, ctx as App.Platform['ctx']);
		}
		return sveltekit.fetch(request, env, ctx);
	},

	async scheduled(_controller: unknown, env: Env, ctx: unknown) {
		// Upstream re-validation is not cron work: passthrough narinfos carry
		// the upstream's TTL as edge max-age (the CDN re-invokes the worker on
		// expiry) and D1 "present" verdicts lazily expire on the same TTL.
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
