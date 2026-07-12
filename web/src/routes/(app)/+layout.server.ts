import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Non-active users never get this far: hooks.server.ts walls them off to
// /pending on every route (pages, actions, and endpoints alike).
export const load: LayoutServerLoad = async ({ locals, url, platform }) => {
	if (!locals.user) {
		const target = url.pathname + url.search;
		redirect(302, `/login?redirect=${encodeURIComponent(target)}`);
	}

	// Surfaced as a badge on the Users nav item so self-signups waiting for
	// activation are discoverable without browsing to /users.
	let pendingUsers = 0;
	const db = platform?.env.ATTIC_DB;
	if (db && locals.user.role === 'admin') {
		const row = await db
			.prepare("SELECT count(*) AS n FROM user WHERE status = 'pending'")
			.first<{ n: number }>();
		pendingUsers = row?.n ?? 0;
	}

	return {
		user: locals.user,
		pendingUsers
	};
};
