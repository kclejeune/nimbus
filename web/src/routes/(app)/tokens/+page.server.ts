import { error, fail } from '@sveltejs/kit';
import {
	auditTokenIssue,
	boundTokenScope,
	listTokens,
	TOKENS_PAGE_SIZE,
	mintAndStore,
	TOKEN_NAME_MAX_CHARS,
	revokeUserToken,
	parseTokenForm
} from '$lib/server/tokens';
import { requireAdmin, tokenMinter } from '$lib/server/auth/guard';
import { parsePage } from '$lib/pagination';
import { hasTokenFilters, isOwnOnly, parseTokenFilters } from '$lib/token-filters';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const self = locals.user.id;
	const page = parsePage(url.searchParams.get('page'));
	const filters = parseTokenFilters(url.searchParams, {
		id: self,
		isAdmin: locals.user.role === 'admin'
	});

	// Read on the primary: this reloads right after a mint or revoke.
	const { tokens, hasMore } = await listTokens(db, {
		limit: TOKENS_PAGE_SIZE,
		offset: (page - 1) * TOKENS_PAGE_SIZE,
		filters
	});
	const ownOnly = isOwnOnly(filters, self);

	return {
		// Your own list has no Owner column (TokenTable shows it when present).
		tokens: ownOnly ? tokens.map(({ owner: _, ...t }) => t) : tokens,
		filters,
		ownOnly,
		filtered: hasTokenFilters(filters),
		page,
		hasMore
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
		if (name.length > TOKEN_NAME_MAX_CHARS) {
			return fail(400, { error: `Token names are limited to ${TOKEN_NAME_MAX_CHARS} characters.` });
		}

		// Mint-time bounding: a token may only carry what its creator holds.
		const bound = boundTokenScope(parseTokenForm(form), await tokenMinter(locals, env.ATTIC_DB));
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

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		// Another owner's row posts its owner; revoking someone else's token is
		// admin-only, the same rule as /users/[id]'s revokeToken. The owner
		// scope in revokeUserToken keeps a mismatched pair a no-op.
		const owner = String(form.get('owner') ?? '') || locals.user.id;
		if (owner !== locals.user.id) requireAdmin(locals);
		await revokeUserToken(db, id, owner, locals.user.id);

		return { revoked: true };
	}
};
