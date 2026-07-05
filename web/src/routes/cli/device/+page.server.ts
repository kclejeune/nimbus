import { error, fail } from '@sveltejs/kit';
import { mintScopedToken, insertApiToken } from '$lib/server/tokens';
import { listCacheNames } from '$lib/server/db/queries';
import type { PageServerLoad, Actions } from './$types';

interface GrantRow {
	user_code: string;
	status: string;
	expires_at: number;
}

export const load: PageServerLoad = async ({ url, locals, platform }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();

	let grant: { userCode: string; status: string; expired: boolean } | null = null;
	if (code) {
		const row = await db
			.prepare('SELECT user_code, status, expires_at FROM device_auth WHERE user_code = ?1')
			.bind(code)
			.first<GrantRow>();
		if (row) {
			grant = {
				userCode: row.user_code,
				status: row.status,
				expired: row.expires_at < Math.floor(Date.now() / 1000)
			};
		}
	}

	return {
		code,
		grant,
		notFound: Boolean(code) && grant === null,
		cacheNames: await listCacheNames(db),
		user: { email: locals.user.email, name: locals.user.name }
	};
};

export const actions: Actions = {
	approve: async ({ request, locals, platform }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		const env = platform?.env;
		if (!env?.ATTIC_DB) throw error(500, 'Database binding unavailable');
		if (!env.JWT_HS256_SECRET_BASE64) return fail(500, { error: 'Token signing not configured.' });

		const form = await request.formData();
		const userCode = String(form.get('user_code') ?? '')
			.trim()
			.toUpperCase();
		const canPull = form.get('pull') === 'on';
		const canPush = form.get('push') === 'on';
		const label = String(form.get('label') ?? 'attic CLI').slice(0, 80);

		const row = await env.ATTIC_DB.prepare(
			'SELECT status, expires_at FROM device_auth WHERE user_code = ?1'
		)
			.bind(userCode)
			.first<{ status: string; expires_at: number }>();
		if (!row) return fail(404, { error: 'Unknown code — check for typos.' });
		if (row.status !== 'pending') return fail(400, { error: 'This code was already used.' });
		if (row.expires_at < Math.floor(Date.now() / 1000)) {
			return fail(400, { error: 'This code has expired — start login again.' });
		}
		if (!canPull && !canPush) return fail(400, { error: 'Grant at least one permission.' });

		const minted = await mintScopedToken(env.JWT_HS256_SECRET_BASE64, locals.user.id, {
			cacheScope: String(form.get('cache') ?? '*'),
			canPull,
			canPush,
			days: Math.max(1, Math.min(3650, Number(form.get('expiry_days') ?? 90)))
		});

		// Store the token and mark the grant approved atomically.
		await env.ATTIC_DB.batch([
			insertApiToken(env.ATTIC_DB, minted, locals.user.id, label),
			env.ATTIC_DB.prepare(
				`UPDATE device_auth SET status = 'approved', scope = ?1, user_id = ?2, token = ?3
				 WHERE user_code = ?4 AND status = 'pending'`
			).bind(JSON.stringify(minted.caches), locals.user.id, minted.token, userCode)
		]);

		return { approved: true };
	}
};
