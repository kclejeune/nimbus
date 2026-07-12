// Admin account-management actions (role, owner flag, activation, deletion),
// shared by the users list page and the user detail page the same way
// grantActions is — both spread these into their `actions`, so each page
// posts to itself with generated types instead of cross-route action URLs.

import { error, fail, type RequestEvent } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import { requireAdmin } from './guard';
import { writeAudit } from '$lib/server/audit';

export async function ownerCount(db: D1Database): Promise<number> {
	const row = await db
		.prepare('SELECT count(*) AS n FROM user WHERE is_owner = 1')
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function isOwner(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT is_owner FROM user WHERE id = ?1')
		.bind(userId)
		.first<{ is_owner: number }>();
	return row?.is_owner === 1;
}

function requireAdminDb({ locals, platform }: RequestEvent): D1Database {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	return db;
}

export function userAdminActions() {
	return {
		setRole: async (event: RequestEvent) => {
			const db = requireAdminDb(event);

			const form = await event.request.formData();
			const userId = String(form.get('userId') ?? '');
			const role = String(form.get('role') ?? '');
			if (role !== 'admin' && role !== 'member') return fail(400, { error: 'Invalid role' });

			if (userId === event.locals.user!.id && role !== 'admin') {
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

		setOwner: async (event: RequestEvent) => {
			const db = requireAdminDb(event);

			const form = await event.request.formData();
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

		setStatus: async (event: RequestEvent) => {
			const db = requireAdminDb(event);

			const form = await event.request.formData();
			const userId = String(form.get('userId') ?? '');
			const status = String(form.get('status') ?? '');
			if (status !== 'active' && status !== 'pending')
				return fail(400, { error: 'Invalid status' });

			if (status === 'pending') {
				if (userId === event.locals.user!.id) {
					return fail(400, { error: 'You cannot deactivate your own account.' });
				}
				if (await isOwner(db, userId)) {
					return fail(400, { error: 'Owners cannot be deactivated.' });
				}
			}

			await db
				.prepare('UPDATE user SET status = ?1, updatedAt = ?2 WHERE id = ?3')
				.bind(status, Math.floor(Date.now() / 1000), userId)
				.run();
			await writeAudit(db, {
				userId: event.locals.user!.id,
				action: status === 'active' ? 'user.activate' : 'user.deactivate',
				target: userId
			});
			return { saved: true };
		},

		deleteUser: async (event: RequestEvent) => {
			const db = requireAdminDb(event);

			const userId = String((await event.request.formData()).get('userId') ?? '');

			if (userId === event.locals.user!.id) {
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
}
