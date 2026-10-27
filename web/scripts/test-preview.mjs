// Exercise the same built-server initialization as Vite preview, through Node's
// native ESM loader. No listener, real credentials, or production bindings.
import assert from 'node:assert/strict';
import { configure } from '../.svelte-kit/output/server/index.js';
import { manifest } from '../.svelte-kit/output/server/manifest.js';

const server = await configure({ manifest, env: {} });
await server.init();
const request = (path) =>
	server.respond(new Request(`https://app.test${path}`), {
		getClientAddress: () => '127.0.0.1'
	});

const unbound = await request('/login');
assert.equal(unbound.status, 200);
assert.match(await unbound.text(), /No sign-in method is configured/);

// Adapter 8 supplies this proxy to both Vite dev and preview. Check the Node
// binding path as well as initialization so a lazy import cannot hide a failure.
globalThis.__sveltekit_cloudflare_platform = {
	env: {
		ATTIC_DB: {
			prepare() {
				throw new Error('Anonymous preview routes must not query D1');
			}
		},
		APP_URL: 'https://app.test',
		SESSION_SECRET: 'a-preview-test-secret-that-is-at-least-32-characters',
		GITHUB_CLIENT_ID: 'preview-test',
		GITHUB_CLIENT_SECRET: 'preview-test'
	},
	ctx: { waitUntil() {} }
};
try {
	const login = await request('/login');
	assert.equal(login.status, 200);
	assert.match(await login.text(), /Continue with GitHub/);
	const protectedPage = await request('/account');
	assert.equal(protectedPage.status, 302);
	assert.equal(protectedPage.headers.get('location'), '/login?redirect=%2Faccount');
	const session = await request('/api/auth/get-session');
	assert.equal(session.status, 200);
	assert.equal(await session.json(), null);
} finally {
	delete globalThis.__sveltekit_cloudflare_platform;
}
console.log('Node preview initialization, binding proxy, login, and authorization checks passed.');
