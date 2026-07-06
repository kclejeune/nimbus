// Custom worker entry: dispatches cache-hostname traffic to the attic
// binary-cache API, everything else to the SvelteKit worker, and adds the
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
import { runGc } from './src/lib/server/attic/gc';
import { handleCacheApi } from './src/lib/server/attic/router';
import { serveStore } from './src/lib/server/attic/store';

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
		return serveStore(request, this.env as Env, this.ctx as App.Platform['ctx']);
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

	async scheduled(_controller: unknown, env: Env, _ctx: unknown) {
		const stats = await runGc(env);
		console.log(`gc: ${JSON.stringify(stats)}`);
	}
};
