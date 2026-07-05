import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { getDb, schema } from '$lib/server/db';

type Env = App.Platform['env'];

/**
 * Build a better-auth instance for the current request.
 *
 * On Cloudflare the D1 binding is only available per-request via
 * `platform.env`, so the instance cannot be a module singleton — call this in
 * hooks and in the mounted API route with the request's env.
 */
export function createAuth(env: Env) {
	const db = getDb(env.ATTIC_DB);

	const providers = [];
	if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
		providers.push(
			genericOAuth({
				config: [
					{
						providerId: 'oidc',
						discoveryUrl: `${env.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
						clientId: env.OIDC_CLIENT_ID,
						clientSecret: env.OIDC_CLIENT_SECRET,
						scopes: ['openid', 'email', 'profile'],
						pkce: true
					}
				]
			})
		);
	}

	return betterAuth({
		database: drizzleAdapter(db, { provider: 'sqlite', schema }),
		secret: env.SESSION_SECRET,
		baseURL: env.APP_URL,
		trustedOrigins: env.APP_URL ? [env.APP_URL] : undefined,
		user: {
			additionalFields: {
				// Populated out-of-band by an admin; never client-settable.
				role: { type: 'string', defaultValue: 'member', input: false }
			}
		},
		plugins: [...providers, sveltekitCookies(getRequestEvent)]
	});
}

export type Auth = ReturnType<typeof createAuth>;
