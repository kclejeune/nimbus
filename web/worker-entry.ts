// Custom worker entry: wraps the SvelteKit-generated worker to add a scheduled
// handler for nightly garbage collection. wrangler.jsonc points `main` here;
// the SvelteKit bundle must be built (vite build) before deploying.
//
// Lives outside src/ deliberately: importing the generated (untyped)
// .svelte-kit/cloudflare/_worker.js from inside the svelte-check project would
// pull the whole bundle into type checking. Everything substantive it calls
// (runGc) is type-checked in src/. The adapter emits to .svelte-kit/cloudflare
// via wrangler.adapter.jsonc, so this file is never overwritten by builds.

import sveltekit from './.svelte-kit/cloudflare/_worker.js';
import { runGc } from './src/lib/server/attic/gc';

export default {
	fetch: sveltekit.fetch,

	async scheduled(_controller: unknown, env: App.Platform['env'], _ctx: unknown) {
		const stats = await runGc(env);
		console.log(`gc: ${JSON.stringify(stats)}`);
	}
};
