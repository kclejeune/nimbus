import { building } from '$app/environment';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle } from '@sveltejs/kit';
import { createAuth, type Auth } from '$lib/server/auth/auth';
import { resolveCfAccessUser } from '$lib/server/auth/cf-access';
import type { SessionUser, UserRole } from '$lib/server/auth/types';

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
// it to the attic binary-cache API before the SvelteKit worker runs.
export const handle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) {
		event.locals.user = null;
		return resolve(event);
	}

	const auth = getAuth(env);

	// Prefer an established better-auth (OIDC) session.
	const session = await auth.api.getSession({ headers: event.request.headers });
	if (session?.user) {
		const u = session.user as typeof session.user & { role?: string };
		event.locals.user = {
			id: u.id,
			sub: u.id,
			provider: 'oidc',
			email: u.email ?? null,
			name: u.name ?? null,
			role: (u.role as UserRole) ?? 'member'
		} satisfies SessionUser;
	} else {
		// Otherwise fall back to a per-request Cloudflare Access assertion.
		event.locals.user = await resolveCfAccessUser(event, env);
	}

	return svelteKitHandler({ event, resolve, auth, building });
};
