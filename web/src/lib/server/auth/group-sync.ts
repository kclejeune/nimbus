// OIDC group-claim → local-group membership sync. Only rows with
// source='sso' are ever created or deleted here; manual memberships are
// admin-owned and untouched. Runs on every OIDC login (auth.ts hook) and on
// CF-Access full resolutions (cf-access.ts) when the claim is present.

import type { D1Database } from '@cloudflare/workers-types';
import { base64urlDecode } from '../attic/token';

/** Decode a JWT payload without verification — the token was just received
 *  from the IdP over the token endpoint; better-auth verified the exchange. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
	const parts = jwt.split('.');
	if (parts.length < 2) return null;
	try {
		const decoded = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
		return typeof decoded === 'object' && decoded !== null ? decoded : null;
	} catch {
		return null;
	}
}

/**
 * Read the groups claim. Returns null when the claim is ABSENT — callers must
 * skip sync entirely then (a login path without the claim must not wipe
 * memberships synced by one that has it). Present-but-empty returns [].
 */
export function extractGroups(
	claims: Record<string, unknown> | null,
	claimName: string
): string[] | null {
	if (!claims || !(claimName in claims)) return null;
	const value = claims[claimName];
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
	return null;
}

export interface MappedGroup {
	id: string;
	oidcGroup: string;
}

export function diffGroupSync(
	mapped: MappedGroup[],
	claimValues: string[],
	currentSsoGroupIds: string[]
): { add: string[]; remove: string[] } {
	const wanted = new Set(mapped.filter((g) => claimValues.includes(g.oidcGroup)).map((g) => g.id));
	const current = new Set(currentSsoGroupIds);
	return {
		add: [...wanted].filter((id) => !current.has(id)),
		remove: [...current].filter((id) => !wanted.has(id))
	};
}

export async function syncUserGroups(
	db: D1Database,
	userId: string,
	claimValues: string[]
): Promise<void> {
	const [mappedRes, currentRes] = await db.batch([
		db.prepare('SELECT id, oidc_group FROM groups WHERE oidc_group IS NOT NULL'),
		db
			.prepare("SELECT group_id FROM group_member WHERE user_id = ?1 AND source = 'sso'")
			.bind(userId)
	]);
	const mapped = ((mappedRes.results ?? []) as { id: string; oidc_group: string }[]).map((r) => ({
		id: r.id,
		oidcGroup: r.oidc_group
	}));
	const current = ((currentRes.results ?? []) as { group_id: string }[]).map((r) => r.group_id);
	const { add, remove } = diffGroupSync(mapped, claimValues, current);
	if (add.length === 0 && remove.length === 0) return;

	const now = Math.floor(Date.now() / 1000);
	// INSERT OR IGNORE: an existing manual row wins over the sso insert, so a
	// later claim removal cannot delete an admin-managed membership.
	await db.batch([
		...add.map((id) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO group_member (group_id, user_id, source, created_at)
					 VALUES (?1, ?2, 'sso', ?3)`
				)
				.bind(id, userId, now)
		),
		...remove.map((id) =>
			db
				.prepare("DELETE FROM group_member WHERE group_id = ?1 AND user_id = ?2 AND source = 'sso'")
				.bind(id, userId)
		)
	]);
}
