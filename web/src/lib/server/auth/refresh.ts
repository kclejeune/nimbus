import type { D1Database } from '@cloudflare/workers-types';
import { readSession } from '$lib/server/cache/db';
import type { SessionUser, UserRole, UserStatus } from './types';

/**
 * Complete a cookie-cached identity (better-auth's session cookie, the Access
 * session cookie) with the role and status read now, so a demotion,
 * deactivation or deletion bites before the cookie expires. Cookies carry no
 * authorization state at all: the type forbids it.
 *
 * Only for cached identities: a user row read or written on the primary in
 * this same request must not be re-read here, because GET/HEAD take a
 * replica whose lag would return the pre-write row (or no row at all for a
 * freshly inserted user) and bounce the first visit to /login.
 *
 * Returns null when the row is gone.
 */
export async function refreshCachedUser(
	db: D1Database,
	method: string,
	user: Omit<SessionUser, 'role' | 'status'>
): Promise<SessionUser | null> {
	// Mutations consult the primary; reads tolerate bounded replica lag (the
	// cookie TTL was the previous bound).
	const source = method === 'GET' || method === 'HEAD' ? readSession(db) : db;
	const current = await source
		.prepare('SELECT role, status FROM user WHERE id = ?1')
		.bind(user.id)
		.first<{ role: UserRole; status: UserStatus }>();
	if (!current) return null;
	return { ...user, role: current.role, status: current.status };
}
