import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Each deploy invalidates the previous build's client chunks, so open
			// tabs would 500 on navigation (or render stale UI) until a hard
			// refresh. Polling version.json makes SvelteKit fall back to a
			// full-page load on the first navigation after a deploy.
			version: { pollInterval: 60_000 },

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			//
			// The adapter emits its worker to the `main` of the given config; it gets
			// a dedicated one so it never overwrites worker-entry.ts (the deploy
			// entry in wrangler.jsonc, which wraps the adapter output to add the
			// scheduled GC handler).
			adapter: adapter({ config: 'wrangler.adapter.jsonc' })
		})
	]
});
