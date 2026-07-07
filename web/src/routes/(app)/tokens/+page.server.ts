import { error, fail } from '@sveltejs/kit';
import { mintAndStore } from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import type { PageServerLoad, Actions } from './$types';

interface TokenRow {
	id: string;
	name: string;
	permissions: string;
	expires_at: number | null;
	revoked_at: number | null;
	created_at: number;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [{ results: tokens }, cacheNames] = await Promise.all([
		db
			.prepare(
				`SELECT id, name, permissions, expires_at, revoked_at, created_at
				 FROM api_token WHERE user_id = ?1 ORDER BY created_at DESC`
			)
			.bind(locals.user.id)
			.all<TokenRow>(),
		listCacheNames(db)
	]);

	const now = Math.floor(Date.now() / 1000);
	return {
		cacheNames,
		tokens: tokens.map((t) => ({
			id: t.id,
			name: t.name,
			scope: t.permissions,
			createdAt: t.created_at,
			expiresAt: t.expires_at,
			status: t.revoked_at
				? ('revoked' as const)
				: t.expires_at && t.expires_at < now
					? ('expired' as const)
					: ('active' as const)
		}))
	};
};

export const actions: Actions = {
	issue: async ({ request, platform, locals }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		const env = platform?.env;
		if (!env?.ATTIC_DB) throw error(500, 'Database binding unavailable');
		if (!env.JWT_HS256_SECRET_BASE64) {
			return fail(500, { error: 'Token signing is not configured (JWT_HS256_SECRET_BASE64).' });
		}

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const canPull = form.get('pull') === 'on';
		const canPush = form.get('push') === 'on';
		const canDelete = form.get('delete') === 'on';

		if (!name) return fail(400, { error: 'Give the token a name.' });
		if (!canPull && !canPush && !canDelete) {
			return fail(400, { error: 'Grant at least one permission.' });
		}
		if (canDelete && locals.user.role !== 'admin') {
			return fail(403, { error: 'Only admins can grant delete.' });
		}

		// The plaintext token is returned exactly once; only its hash is stored.
		const minted = await mintAndStore(
			env.ATTIC_DB,
			env.JWT_HS256_SECRET_BASE64,
			locals.user.id,
			name,
			{
				cacheScope: String(form.get('cache') ?? '*'),
				canPull,
				canPush,
				canDelete,
				days: Math.max(1, Math.min(3650, Number(form.get('expiry_days') ?? 90)))
			}
		);
		return { issued: { name, token: minted.token } };
	},

	revoke: async ({ request, platform, locals }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const id = String((await request.formData()).get('id') ?? '');
		await db
			.prepare('UPDATE api_token SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3')
			.bind(Math.floor(Date.now() / 1000), id, locals.user.id)
			.run();

		return { revoked: true };
	}
};
