import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, platform }) => {
	if (locals.user) {
		redirect(302, url.searchParams.get('redirect') ?? '/');
	}
	return {
		oidcConfigured: Boolean(platform?.env.OIDC_ISSUER),
		githubConfigured: Boolean(platform?.env.GITHUB_CLIENT_ID && platform?.env.GITHUB_CLIENT_SECRET),
		accessConfigured: Boolean(platform?.env.CF_ACCESS_TEAM_DOMAIN),
		redirectTo: url.searchParams.get('redirect') ?? '/',
		// Set by better-auth's OAuth callback on a failed sign-in (e.g.
		// signup_disabled when the GitHub account isn't linked to any user).
		errorCode: url.searchParams.get('error')
	};
};
