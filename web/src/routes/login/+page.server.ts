import { redirect } from '@sveltejs/kit';
import { configuredProviders } from '$lib/server/auth/providers';
import { safeRedirectPath } from '$lib/server/auth/redirect';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, platform }) => {
	const redirectTo = safeRedirectPath(url.searchParams.get('redirect'), url.origin);
	if (locals.user) {
		redirect(302, redirectTo);
	}
	return {
		providers: configuredProviders(platform?.env),
		accessConfigured: Boolean(platform?.env.CF_ACCESS_TEAM_DOMAIN),
		redirectTo,
		// Set by better-auth's OAuth callback on a failed sign-in (e.g.
		// signup_disabled when the account isn't linked to any user).
		errorCode: url.searchParams.get('error')
	};
};
