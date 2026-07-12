/** How a user authenticated. */
export type AuthProvider = 'oidc' | 'cf-access';

/** Application role, controlling access to admin functions. */
export type UserRole = 'admin' | 'member';

/** Instance access gate; admins bypass (see isActiveUser). */
export type UserStatus = 'pending' | 'active';

/**
 * THE activation rule, stated once: admins are never locked out by status.
 * Everything derives from this — the hooks activation wall, the cookie fast
 * path, effective-access resolution, and protocol token suspension
 * (cache/db.ts isTokenDisabled). Lives here (dependency-free) so the cache
 * worker can import it without dragging in SvelteKit.
 */
export function isActiveUser(user: { role: string; status: string }): boolean {
	return user.role === 'admin' || user.status === 'active';
}

/** The authenticated user attached to a request (`event.locals.user`). */
export interface SessionUser {
	/** better-auth user id (text). */
	id: string;
	sub: string;
	provider: AuthProvider;
	email: string | null;
	name: string | null;
	role: UserRole;
	status: UserStatus;
}
