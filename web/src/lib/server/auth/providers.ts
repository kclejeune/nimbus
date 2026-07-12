import type { GenericOAuthConfig } from 'better-auth/plugins';
import type { SocialProviderList, SocialProviders } from 'better-auth/social-providers';

type Env = App.Platform['env'];
type SocialProviderId = SocialProviderList[number];

/**
 * A provider as shown in the UI. Discriminated by `kind` — better-auth
 * built-in social providers use signIn.social/linkSocial; generic OAuth
 * providers (registered via the genericOAuth plugin) use
 * signIn.oauth2/oauth2.link. Narrowing on `kind` narrows `id` to what the
 * corresponding client call accepts.
 */
export type ProviderInfo =
	| { id: SocialProviderId; label: string; kind: 'social' }
	| { id: string; label: string; kind: 'oauth2' };

const LABELS: Record<string, string> = {
	oidc: 'SSO',
	cloudflare: 'Cloudflare',
	github: 'GitHub',
	google: 'Google'
};

/**
 * Env-gated provider registrations — the single source of truth. auth.ts
 * registers these with better-auth and configuredProviders() derives the
 * login/settings UI from the same result, so a provider added here lights up
 * everything at once.
 *
 * All non-primary providers are link-only (disableImplicitSignUp): they sign
 * in accounts previously linked from /settings but never create users — new
 * users must arrive via the primary OIDC provider.
 */
export function buildAuthProviders(env: Env): {
	oauth: GenericOAuthConfig[];
	social: SocialProviders;
} {
	const oauth: GenericOAuthConfig[] = [];
	if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
		oauth.push({
			providerId: 'oidc',
			discoveryUrl: `${env.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
			clientId: env.OIDC_CLIENT_ID,
			clientSecret: env.OIDC_CLIENT_SECRET,
			scopes: ['openid', 'email', 'profile', ...(env.OIDC_GROUPS_CLAIM ? ['groups'] : [])],
			pkce: true
		});
	}
	// Cloudflare SSO (Access for SaaS, OIDC mode) — distinct from the
	// Cf-Access-Jwt-Assertion path in cf-access.ts, which fronts self-hosted
	// apps and never participates in linking. Enable PKCE on the SaaS app.
	if (env.CF_SSO_CLIENT_ID && env.CF_SSO_CLIENT_SECRET && env.CF_ACCESS_TEAM_DOMAIN) {
		const team = env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
		oauth.push({
			providerId: 'cloudflare',
			discoveryUrl: `${team}/cdn-cgi/access/sso/oidc/${env.CF_SSO_CLIENT_ID}/.well-known/openid-configuration`,
			clientId: env.CF_SSO_CLIENT_ID,
			clientSecret: env.CF_SSO_CLIENT_SECRET,
			scopes: ['openid', 'email', 'profile'],
			pkce: true,
			disableImplicitSignUp: true
		});
	}

	const social: SocialProviders = {};
	if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
		social.github = {
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET,
			disableImplicitSignUp: true
		};
	}
	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
		social.google = {
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			disableImplicitSignUp: true
		};
	}

	return { oauth, social };
}

/** The enabled providers as shown on the login and settings pages. */
export function configuredProviders(env: Env | undefined): ProviderInfo[] {
	if (!env) return [];
	const { oauth, social } = buildAuthProviders(env);
	return [
		...oauth.map((c): ProviderInfo => ({
			id: c.providerId,
			label: LABELS[c.providerId] ?? c.providerId,
			kind: 'oauth2'
		})),
		...(Object.keys(social) as SocialProviderId[]).map((id): ProviderInfo => ({
			id,
			label: LABELS[id] ?? id,
			kind: 'social'
		}))
	];
}
