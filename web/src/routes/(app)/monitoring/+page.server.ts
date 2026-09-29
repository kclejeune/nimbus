import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Renamed to /usage; keep old links and bookmarks working.
export const load: PageServerLoad = ({ url }) => {
	redirect(308, `/usage${url.search}`);
};
