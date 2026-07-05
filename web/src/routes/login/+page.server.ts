import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, platform }) => {
	if (locals.user) {
		redirect(302, url.searchParams.get('redirect') ?? '/');
	}
	return {
		oidcConfigured: Boolean(platform?.env.OIDC_ISSUER),
		accessConfigured: Boolean(platform?.env.CF_ACCESS_TEAM_DOMAIN),
		redirectTo: url.searchParams.get('redirect') ?? '/'
	};
};
