import { error, fail, redirect } from '@sveltejs/kit';
import { auditTokenIssue, boundTokenScope, mintAndStore } from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { tokenScopeOptions } from '$lib/server/auth/permissions';
import type { PageServerLoad, Actions } from './$types';

function parsePort(raw: string | null): number | null {
	const port = Number(raw);
	return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

export const load: PageServerLoad = async ({ url, locals, platform }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const port = parsePort(url.searchParams.get('port'));
	const state = url.searchParams.get('state') ?? '';
	if (port === null || !state) {
		throw error(400, 'Invalid CLI authorization request (missing port or state).');
	}

	return {
		port,
		state,
		label: url.searchParams.get('label') ?? 'attic CLI',
		hostname: url.searchParams.get('hostname') ?? '',
		scopeOptions: tokenScopeOptions(
			...(await Promise.all([effectiveAccessOf(locals, db), listCacheNames(db)]))
		),
		user: { email: locals.user.email, name: locals.user.name }
	};
};

export const actions: Actions = {
	authorize: async ({ request, locals, platform }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		const env = platform?.env;
		if (!env?.ATTIC_DB) throw error(500, 'Database binding unavailable');
		if (!env.JWT_HS256_SECRET_BASE64) {
			return fail(500, { error: 'Token signing is not configured.' });
		}

		const form = await request.formData();
		const port = parsePort(String(form.get('port')));
		const state = String(form.get('state') ?? '');
		if (port === null || !state) return fail(400, { error: 'Invalid request.' });

		const bound = await boundTokenScope(form, locals, env.ATTIC_DB);
		if (!bound.ok) return fail(403, { error: bound.denial });

		const minted = await mintAndStore(
			env.ATTIC_DB,
			env.JWT_HS256_SECRET_BASE64,
			locals.user.id,
			String(form.get('label') ?? 'attic CLI').slice(0, 80),
			bound.scope
		);
		await auditTokenIssue(env.ATTIC_DB, locals.user.id, minted.jti, bound.scope, 'cli-loopback');

		// Hand the token back to the CLI's loopback listener. The host is fixed to
		// 127.0.0.1 (only the port is caller-supplied), so there is no open-redirect.
		const target = `http://127.0.0.1:${port}/callback?token=${encodeURIComponent(minted.token)}&state=${encodeURIComponent(state)}`;
		redirect(303, target);
	}
};
