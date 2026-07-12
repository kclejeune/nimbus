import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// --- better-auth managed tables ---------------------------------------------
// Column names match better-auth's default field names (camelCase) so no
// field mapping is needed in the adapter.

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	// Admin-specific additional field (declared in auth config too).
	role: text('role').notNull().default('member'),
	// Exactly-protected owner(s); at least one must always exist.
	isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
	/** Instance access gate: 'pending' until an admin or the OIDC activation
	 *  group activates. Admins bypass (see guard.ts isActiveUser). */
	status: text('status').notNull().default('pending'),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull()
});

export const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
	token: text('token').notNull().unique(),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
	ipAddress: text('ipAddress'),
	userAgent: text('userAgent'),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' })
});

export const account = sqliteTable('account', {
	id: text('id').primaryKey(),
	accountId: text('accountId').notNull(),
	providerId: text('providerId').notNull(),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	accessToken: text('accessToken'),
	refreshToken: text('refreshToken'),
	idToken: text('idToken'),
	accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
	refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
	scope: text('scope'),
	password: text('password'),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull()
});

export const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
	createdAt: integer('createdAt', { mode: 'timestamp' }),
	updatedAt: integer('updatedAt', { mode: 'timestamp' })
});

// --- admin-owned tables ------------------------------------------------------

/** API tokens minted for users (CI/programmatic access). Only the hash is stored. */
export const apiToken = sqliteTable('api_token', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	tokenHash: text('token_hash').notNull(),
	/** JSON: attic cache permission map this token grants. */
	permissions: text('permissions').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }),
	revokedAt: integer('revoked_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});

/** Audit trail of privileged admin actions. */
export const auditLog = sqliteTable('audit_log', {
	id: text('id').primaryKey(),
	userId: text('user_id').references(() => user.id),
	action: text('action').notNull(),
	target: text('target'),
	detail: text('detail'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});

// --- fine-grained permissions ------------------------------------------------

/** Local permission groups. `oidcGroup` maps an IdP group-claim value to this
 *  group; membership rows with source='sso' are synced from it at login. */
export const group = sqliteTable('groups', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	oidcGroup: text('oidc_group'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});

export const groupMember = sqliteTable(
	'group_member',
	{
		groupId: text('group_id')
			.notNull()
			.references(() => group.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** 'manual' rows are admin-managed; 'sso' rows are owned by group sync. */
		source: text('source').notNull().default('manual'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
	},
	(t) => [
		primaryKey({ columns: [t.groupId, t.userId] }),
		// Effective-access resolution and login group sync both filter by user.
		index('group_member_user_idx').on(t.userId)
	]
);

/** One grant: subject (user|group) × cache-name pattern × attic permission
 *  bits (JSON). Effective access is the union. No cross-type FK on
 *  subject_id; the app deletes grants alongside subjects. */
export const permissionGrant = sqliteTable(
	'permission_grant',
	{
		id: text('id').primaryKey(),
		subjectType: text('subject_type').notNull(),
		subjectId: text('subject_id').notNull(),
		pattern: text('pattern').notNull(),
		actions: text('actions').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		createdBy: text('created_by')
	},
	(t) => [index('permission_grant_subject_idx').on(t.subjectType, t.subjectId)]
);
