import { error } from '@sveltejs/kit';
import { configuredProviders } from '$lib/server/auth/providers';
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

	const { results: accounts } = await db
		.prepare(
			`SELECT id, providerId, accountId, createdAt
			 FROM account WHERE userId = ?1 ORDER BY createdAt`
		)
		.bind(locals.user.id)
		.all<AccountRow>();

	return {
		// Cloudflare Access users have no better-auth session, so the link and
		// unlink endpoints (which require one) are unavailable to them.
		sessionProvider: locals.user.provider,
		accounts,
		providers: configuredProviders(platform?.env)
	};
};
