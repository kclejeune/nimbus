import { redirect } from '@sveltejs/kit';
import { configuredProviders } from '$lib/server/auth/providers';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, platform }) => {
	if (locals.user) {
		redirect(302, url.searchParams.get('redirect') ?? '/');
	}
	return {
		providers: configuredProviders(platform?.env),
		accessConfigured: Boolean(platform?.env.CF_ACCESS_TEAM_DOMAIN),
		redirectTo: url.searchParams.get('redirect') ?? '/',
		// Set by better-auth's OAuth callback on a failed sign-in (e.g.
		// signup_disabled when the account isn't linked to any user).
		errorCode: url.searchParams.get('error')
	};
};
