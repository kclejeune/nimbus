import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { userAdminActions } from '$lib/server/auth/user-admin';
import { isCfAccessId } from '$lib/server/auth/cf-access';
import type { PageServerLoad, Actions } from './$types';

interface UserRow {
	id: string;
	name: string;
	email: string;
	role: string;
	is_owner: number;
	status: string;
	createdAt: number;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const { results } = await db
		.prepare(
			'SELECT id, name, email, role, is_owner, status, createdAt FROM user ORDER BY createdAt'
		)
		.all<UserRow>();

	const owners = results.filter((u) => u.is_owner === 1).length;

	return {
		currentUserId: locals.user!.id,
		// The last remaining owner is undeletable/undemotable; the UI uses this to
		// gray out the relevant controls.
		lastOwner: owners <= 1,
		users: results.map((u) => ({
			id: u.id,
			name: u.name,
			email: u.email,
			role: u.role,
			provider: isCfAccessId(u.id) ? 'Cloudflare Access' : 'OIDC',
			createdAt: u.createdAt,
			isOwner: u.is_owner === 1,
			status: u.status
		}))
	};
};

export const actions: Actions = {
	addUser: async ({ request, platform, locals }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const form = await request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();
		const role = form.get('role') === 'admin' ? 'admin' : 'member';

		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			return fail(400, { error: 'Enter a valid email address.' });
		}

		const existing = await db
			.prepare('SELECT id FROM user WHERE email = ?1')
			.bind(email)
			.first<{ id: string }>();
		if (existing) return fail(400, { error: 'A user with that email already exists.' });

		// Pre-provision the account; it adopts the assigned role on first sign-in.
		// Both auth paths match by email: Cloudflare Access in upsertAccessUser,
		// and better-auth via implicit account linking (the provider's verified
		// email attaching to this row — emailVerified=1 below is what permits it).
		const now = Math.floor(Date.now() / 1000);
		await db
			.prepare(
				`INSERT INTO user (id, name, email, emailVerified, role, is_owner, status, createdAt, updatedAt)
				 VALUES (?1, ?2, ?3, 1, ?4, 0, 'active', ?5, ?5)`
			)
			.bind(crypto.randomUUID(), email, email, role, now)
			.run();

		return { added: email };
	},

	...userAdminActions()
};
