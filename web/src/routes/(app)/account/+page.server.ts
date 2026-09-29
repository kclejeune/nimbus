import { error } from '@sveltejs/kit';
import { configuredProviders } from '$lib/server/auth/providers';
import { loadUserAccess } from '$lib/server/auth/user-access';
import type { PageServerLoad } from './$types';

interface AccountRow {
	id: string;
	providerId: string;
	accountId: string;
	createdAt: number;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// The viewer's own profile: always self, so no admin check is needed and
	// nothing here can reach another user's data.
	const [{ results: accounts }, access] = await Promise.all([
		db
			.prepare(
				`SELECT id, providerId, accountId, createdAt
				 FROM account WHERE userId = ?1 ORDER BY createdAt`
			)
			.bind(locals.user.id)
			.all<AccountRow>(),
		loadUserAccess(db, locals.user.id)
	]);

	return {
		// Cloudflare Access users have no better-auth session, so the link and
		// unlink endpoints (which require one) are unavailable to them.
		sessionProvider: locals.user.provider,
		accounts,
		access,
		providers: configuredProviders(platform?.env)
	};
};
