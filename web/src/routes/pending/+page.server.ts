import { redirect } from '@sveltejs/kit';
import { isActiveUser } from '$lib/server/auth/guard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.user) redirect(302, '/login');
	if (isActiveUser(locals.user)) redirect(302, '/');
	return {
		user: { email: locals.user.email, name: locals.user.name, provider: locals.user.provider },
		accessConfigured: Boolean(platform?.env.CF_ACCESS_TEAM_DOMAIN)
	};
};
