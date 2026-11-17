import { uiRead } from '$lib/server/ui-read-cache';
import { redirect } from '@sveltejs/kit';
import { readSession } from '$lib/server/cache/db';
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
	let badgeUnavailable = false;
	const db = platform?.env.ATTIC_DB;
	if (db && locals.user.role === 'admin') {
		// Runs on every app navigation; a replica read keeps it off the primary
		// (a just-activated user's badge lagging one navigation is fine).
		const snapshot = await uiRead(
			db,
			'pending-users',
			async () => {
				const row = await readSession(db)
					.prepare("SELECT count(*) AS n FROM user WHERE status = 'pending'")
					.first<{ n: number }>();
				return row?.n ?? 0;
			},
			0
		);
		pendingUsers = snapshot.value;
		badgeUnavailable = snapshot.stale || snapshot.unavailable;
	}

	return {
		user: locals.user,
		pendingUsers,
		badgeUnavailable
	};
};
