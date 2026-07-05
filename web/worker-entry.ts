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

import sveltekit from './.svelte-kit/cloudflare/_worker.js';
import { runGc } from './src/lib/server/attic/gc';
import { handleCacheApi } from './src/lib/server/attic/router';

type Env = App.Platform['env'];

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
