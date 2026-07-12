import { redirect } from '@sveltejs/kit';
import { isActiveUser } from '$lib/server/auth/guard';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const target = url.pathname + url.search;
		redirect(302, `/login?redirect=${encodeURIComponent(target)}`);
	}
	if (!isActiveUser(locals.user)) redirect(302, '/pending');
	return {
		user: locals.user
	};
};
