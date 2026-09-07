import { building } from '$app/environment';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { redirect, type Handle } from '@sveltejs/kit';
import { createAuth, type Auth } from '$lib/server/auth/auth';
import { resolveCfAccessUser } from '$lib/server/auth/cf-access';
import { isActiveUser } from '$lib/server/auth/guard';
import type { UserRole, UserStatus } from '$lib/server/auth/types';
import { checkRateLimit } from '$lib/server/rate-limit';
import { refreshCachedUser } from '$lib/server/auth/refresh';

// Cache the better-auth instance per D1 binding (stable per isolate).
// Nothing in createAuth() closes over per-request state: baseURL comes from
// env.APP_URL (stable), and sveltekitCookies receives getRequestEvent (a stable
// function reference that resolves the current request lazily, not at construction).
const authCache = new WeakMap<object, Auth>();

function getAuth(env: App.Platform['env']): Auth {
	let auth = authCache.get(env.ATTIC_DB);
	if (!auth) {
		auth = createAuth(env);
		authCache.set(env.ATTIC_DB, auth);
	}
	return auth;
}

// Cache-hostname traffic never reaches SvelteKit: worker-entry.ts dispatches
// it to the binary-cache API before the SvelteKit worker runs.
export const handle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) {
		event.locals.user = null;
		return resolve(event);
	}

	if (
		event.route.id === '/api/auth/[...all]' ||
		event.url.pathname === '/api/auth' ||
		event.url.pathname.startsWith('/api/auth/')
	) {
		const limited = await checkRateLimit(event.request, env.AUTH_LIMITER);
		if (limited) return limited;
	}
	const auth = getAuth(env);

	// Prefer an established better-auth (OIDC) session.
	const session = await auth.api.getSession({ headers: event.request.headers });
	if (session?.user) {
		event.locals.user = await refreshCachedUser(env.ATTIC_DB, event.request.method, {
			id: session.user.id,
			sub: session.user.id,
			provider: 'oidc',
			email: session.user.email ?? null,
			name: session.user.name ?? null
		});
	} else {
		// Otherwise a per-request Cloudflare Access assertion.
		event.locals.user = await resolveCfAccessUser(event, env);
	}

	// Activation wall, enforced centrally so it covers form actions and
	// +server endpoints, not just page loads. Gated by route group — the app
	// dashboard and the CLI token flows — so /login, /pending, and the auth
	// API (sign-in/sign-out) stay reachable by construction, and new public
	// routes aren't silently walled. loadEffectiveAccess independently
	// resolves non-active users to no access.
	const user = event.locals.user;
	const routeId = event.route.id;
	const gated = routeId != null && (routeId.startsWith('/(app)') || routeId.startsWith('/cli'));
	// Layout and child loads run concurrently; a layout redirect cannot
	// protect a child's database work.
	if (gated && !user) {
		if (event.request.method === 'GET' || event.request.method === 'HEAD') {
			redirect(302, `/login?redirect=${encodeURIComponent(event.url.pathname + event.url.search)}`);
		}
		return new Response('Authentication required', { status: 401 });
	}
	if (gated && user && !isActiveUser(user)) {
		if (event.request.method === 'GET') redirect(302, '/pending');
		return new Response('Account pending approval', { status: 403 });
	}

	return svelteKitHandler({ event, resolve, auth, building });
};
