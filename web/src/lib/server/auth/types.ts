/** How a user authenticated. */
export type AuthProvider = 'oidc' | 'cf-access';

/** Application role, controlling access to admin functions. */
export type UserRole = 'admin' | 'member';

/** The authenticated user attached to a request (`event.locals.user`). */
export interface SessionUser {
	/** better-auth user id (text). */
	id: string;
	sub: string;
	provider: AuthProvider;
	email: string | null;
	name: string | null;
	role: UserRole;
}
