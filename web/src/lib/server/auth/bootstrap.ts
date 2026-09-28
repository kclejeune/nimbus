import type { D1Database } from '@cloudflare/workers-types';

/**
 * Bootstrap edge, shared by every sign-in path: while no admin exists, the
 * user signing in becomes an active admin and the protected owner, so a fresh
 * deployment (or one whose admins were all removed out of band) always has
 * someone who can manage the rest.
 *
 * A read gates the write, since pending Access users resolve on every request.
 * The UPDATE repeats the condition, so concurrent first sign-ins cannot both
 * win: D1 serializes writes on the primary. Returns the promoted role and
 * status, or null when nothing changed.
 */
export async function claimBootstrapAdmin(
	db: D1Database,
	userId: string
): Promise<{ role: 'admin'; status: 'active' } | null> {
	if (await db.prepare("SELECT 1 FROM user WHERE role = 'admin' LIMIT 1").first()) return null;
	const result = await db
		.prepare(
			"UPDATE user SET role = 'admin', status = 'active', is_owner = 1 " +
				"WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM user WHERE role = 'admin')"
		)
		.bind(userId)
		.run();
	return (result.meta.changes ?? 0) > 0 ? { role: 'admin', status: 'active' } : null;
}
