import { error, fail } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import type { PageServerLoad, Actions } from './$types';

interface UserRow {
	id: string;
	name: string;
	email: string;
	role: string;
	is_owner: number;
	createdAt: number;
}

function requireAdmin(locals: App.Locals) {
	if (!locals.user) throw error(401, 'Not signed in');
	if (locals.user.role !== 'admin') throw error(403, 'Admins only');
}

async function ownerCount(db: D1Database): Promise<number> {
	const row = await db
		.prepare('SELECT count(*) AS n FROM user WHERE is_owner = 1')
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function isOwner(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT is_owner FROM user WHERE id = ?1')
		.bind(userId)
		.first<{ is_owner: number }>();
	return row?.is_owner === 1;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const { results } = await db
		.prepare('SELECT id, name, email, role, is_owner, createdAt FROM user ORDER BY createdAt')
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
			provider: u.id.startsWith('cfaccess:') ? 'Cloudflare Access' : 'OIDC',
			createdAt: u.createdAt,
			isOwner: u.is_owner === 1
		}))
	};
};

export const actions: Actions = {
	setRole: async ({ request, platform, locals }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const form = await request.formData();
		const userId = String(form.get('userId') ?? '');
		const role = String(form.get('role') ?? '');
		if (role !== 'admin' && role !== 'member') return fail(400, { error: 'Invalid role' });

		if (userId === locals.user!.id && role !== 'admin') {
			return fail(400, { error: 'You cannot remove your own admin role.' });
		}
		// An owner always retains admin capabilities; demote ownership first.
		if (role !== 'admin' && (await isOwner(db, userId))) {
			return fail(400, { error: 'Remove owner status before changing this role.' });
		}

		await db
			.prepare('UPDATE user SET role = ?1, updatedAt = ?2 WHERE id = ?3')
			.bind(role, Math.floor(Date.now() / 1000), userId)
			.run();

		return { saved: true };
	},

	setOwner: async ({ request, platform, locals }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const form = await request.formData();
		const userId = String(form.get('userId') ?? '');
		const owner = form.get('owner') === 'true';
		const now = Math.floor(Date.now() / 1000);

		if (owner) {
			// Granting ownership implies admin.
			await db
				.prepare('UPDATE user SET is_owner = 1, role = ?1, updatedAt = ?2 WHERE id = ?3')
				.bind('admin', now, userId)
				.run();
			return { saved: true };
		}

		// Revoking ownership: never drop below one owner.
		if ((await isOwner(db, userId)) && (await ownerCount(db)) <= 1) {
			return fail(400, { error: 'Add another owner before removing the last one.' });
		}
		await db
			.prepare('UPDATE user SET is_owner = 0, updatedAt = ?1 WHERE id = ?2')
			.bind(now, userId)
			.run();
		return { saved: true };
	},

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
				`INSERT INTO user (id, name, email, emailVerified, role, is_owner, createdAt, updatedAt)
				 VALUES (?1, ?2, ?3, 1, ?4, 0, ?5, ?5)`
			)
			.bind(crypto.randomUUID(), email, email, role, now)
			.run();

		return { added: email };
	},

	deleteUser: async ({ request, platform, locals }) => {
		requireAdmin(locals);
		const db = platform?.env.ATTIC_DB;
		if (!db) throw error(500, 'Database binding unavailable');

		const userId = String((await request.formData()).get('userId') ?? '');

		if (userId === locals.user!.id) {
			return fail(400, { error: 'You cannot delete your own account.' });
		}
		if ((await isOwner(db, userId)) && (await ownerCount(db)) <= 1) {
			return fail(400, { error: 'Add another owner before deleting the last one.' });
		}

		// D1 enforces FKs but the schema has no ON DELETE CASCADE, so delete
		// dependents before the user row (children first).
		await db.batch([
			db.prepare('DELETE FROM api_token WHERE user_id = ?1').bind(userId),
			db.prepare('DELETE FROM session WHERE userId = ?1').bind(userId),
			db.prepare('DELETE FROM account WHERE userId = ?1').bind(userId),
			db.prepare('DELETE FROM user WHERE id = ?1').bind(userId)
		]);

		return { deleted: true };
	}
};
