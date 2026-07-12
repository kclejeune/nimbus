import { error, fail } from '@sveltejs/kit';
import {
	auditTokenIssue,
	boundTokenScope,
	listUserTokens,
	mintAndStore,
	revokeUserToken
} from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { tokenScopeOptions } from '$lib/server/auth/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [tokens, cacheNames, access] = await Promise.all([
		listUserTokens(db, locals.user.id),
		listCacheNames(db),
		effectiveAccessOf(locals, db)
	]);

	return {
		scopeOptions: tokenScopeOptions(access, cacheNames),
		tokens
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
		if (!name) return fail(400, { error: 'Give the token a name.' });

		// Mint-time bounding: a token may only carry what its creator holds.
		const bound = await boundTokenScope(form, locals, env.ATTIC_DB);
		if (!bound.ok) return fail(403, { error: bound.denial });

		// The plaintext token is returned exactly once; only its hash is stored.
		const minted = await mintAndStore(
			env.ATTIC_DB,
			env.JWT_HS256_SECRET_BASE64,
			locals.user.id,
			name,
			bound.scope
		);
		await auditTokenIssue(env.ATTIC_DB, locals.user.id, minted.jti, bound.scope);
		return { issued: { name, token: minted.token } };
	},

	revoke: async ({ request, platform, locals }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const id = String((await request.formData()).get('id') ?? '');
		await revokeUserToken(db, id, locals.user.id, locals.user.id);

		return { revoked: true };
	}
};
