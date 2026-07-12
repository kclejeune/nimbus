import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { and, desc, eq } from 'drizzle-orm';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { getDb, schema } from '$lib/server/db';
import { buildAuthProviders } from './providers';
import { decodeJwtClaims, extractGroups, syncUserGroups } from './group-sync';

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
	const { oauth, social } = buildAuthProviders(env);

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
		socialProviders: social,
		user: {
			additionalFields: {
				// Populated out-of-band by an admin; never client-settable.
				role: { type: 'string', defaultValue: 'member', input: false }
			}
		},
		hooks: {
			// Group sync must run on EVERY oidc login, not just sign-up: the
			// callback refreshes account.idToken, which carries the groups claim.
			after: createAuthMiddleware(async (ctx) => {
				if (!env.OIDC_GROUPS_CLAIM) return;
				if (!ctx.path.startsWith('/oauth2/callback/oidc')) return;
				const userId = ctx.context.newSession?.user.id;
				if (!userId) return;
				try {
					const rows = await db
						.select({ idToken: schema.account.idToken })
						.from(schema.account)
						.where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'oidc')))
						.orderBy(desc(schema.account.updatedAt))
						.limit(1);
					const idToken = rows[0]?.idToken;
					if (!idToken) return;
					const groups = extractGroups(decodeJwtClaims(idToken), env.OIDC_GROUPS_CLAIM);
					if (groups === null) return; // claim absent: never wipe
					await syncUserGroups(env.ATTIC_DB, userId, groups);
				} catch (e) {
					console.warn(`oidc group sync failed: ${e}`);
				}
			})
		},
		plugins: [
			...(oauth.length > 0 ? [genericOAuth({ config: oauth })] : []),
			sveltekitCookies(getRequestEvent)
		]
	});
}

export type Auth = ReturnType<typeof createAuth>;
