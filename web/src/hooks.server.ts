import { building } from '$app/environment';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle } from '@sveltejs/kit';
import { createAuth } from '$lib/server/auth/auth';
import { resolveCfAccessUser } from '$lib/server/auth/cf-access';
import { handleCacheApi } from '$lib/server/attic/router';
import type { SessionUser, UserRole } from '$lib/server/auth/types';

/** Whether the request is addressed to the binary-cache hostname (cache.kclj.io). */
function isCacheHost(event: Parameters<Handle>[0]['event'], cacheBaseUrl?: string): boolean {
	if (!cacheBaseUrl) return false;
	const cacheHost = new URL(cacheBaseUrl).host;
	// The Host header can be rewritten by local dev proxies, so accept a match
	// on either the resolved URL host or the raw header.
	return event.url.host === cacheHost || event.request.headers.get('host') === cacheHost;
}

export const handle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) {
		event.locals.user = null;
		return resolve(event);
	}

	// Requests on the cache hostname are the attic binary-cache API, not the
	// admin UI — dispatch them before any session handling.
	if (isCacheHost(event, env.CACHE_BASE_URL)) {
		return handleCacheApi(event.request, env, event.platform?.ctx);
	}

	const auth = createAuth(env);

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
