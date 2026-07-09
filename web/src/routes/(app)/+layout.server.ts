import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, platform }) => {
	if (!locals.user) {
		const target = url.pathname + url.search;
		redirect(302, `/login?redirect=${encodeURIComponent(target)}`);
	}
	return {
		user: locals.user,
		// Sign-out must also end the Cloudflare Access session when Access
		// fronts this domain — see nav-user.svelte.
		accessConfigured: Boolean(platform?.env.CF_ACCESS_TEAM_DOMAIN)
	};
};
