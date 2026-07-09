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
		// One user, many provider accounts. Providers can disagree on email
		// (e.g. the OIDC IdP vs GitHub), so explicit linking from /settings is
		// allowed across emails — identity is anchored to the signed-in
		// session, not the address the provider reports.
		account: {
			accountLinking: {
				enabled: true,
				allowDifferentEmails: true
			}
		},
		// GitHub is link-only: it signs in accounts previously linked from
		// /settings but never creates users (disableImplicitSignUp). New users
		// must arrive via the OIDC provider.
		socialProviders:
			env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? {
						github: {
							clientId: env.GITHUB_CLIENT_ID,
							clientSecret: env.GITHUB_CLIENT_SECRET,
							disableImplicitSignUp: true
						}
					}
				: undefined,
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
