import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const target = url.pathname + url.search;
		redirect(302, `/login?redirect=${encodeURIComponent(target)}`);
	}
	return { user: locals.user };
};
