import type { D1Database } from '@cloudflare/workers-types';

/**
 * Bootstrap edge, shared by every sign-in path. A fresh deployment promotes
 * its first user, then records a durable one-way latch. Removing every admin
 * later cannot silently turn the next arbitrary signer into the owner.
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
	if (await db.prepare('SELECT 1 FROM bootstrap_state WHERE id = 1 LIMIT 1').first()) return null;
	if (await db.prepare("SELECT 1 FROM user WHERE role = 'admin' LIMIT 1").first()) {
		await db
			.prepare('INSERT OR IGNORE INTO bootstrap_state (id, completed_at) VALUES (1, unixepoch())')
			.run();
		return null;
	}
	const promotion = await db
		.prepare(
			"UPDATE user SET role = 'admin', status = 'active', is_owner = 1 " +
				'WHERE id = ?1 ' +
				"AND NOT EXISTS (SELECT 1 FROM user WHERE role = 'admin') " +
				'AND NOT EXISTS (SELECT 1 FROM bootstrap_state WHERE id = 1)'
		)
		.bind(userId)
		.run();
	// Also latches upgraded installations that already have an admin. D1
	// serializes both competing UPDATEs, so concurrent first sign-ins cannot
	// both pass the NOT EXISTS predicate.
	await db
		.prepare(
			'INSERT OR IGNORE INTO bootstrap_state (id, completed_at) ' +
				"SELECT 1, unixepoch() WHERE EXISTS (SELECT 1 FROM user WHERE role = 'admin')"
		)
		.run();
	return (promotion.meta.changes ?? 0) > 0 ? { role: 'admin', status: 'active' } : null;
}
