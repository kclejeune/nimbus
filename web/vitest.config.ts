import { defineConfig } from 'vitest/config';

// Tests target pure server modules only, so plain node + a $lib alias is
// enough — no SvelteKit plugin, no worker runtime emulation.
export default defineConfig({
	resolve: {
		alias: { $lib: new URL('./src/lib', import.meta.url).pathname }
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
