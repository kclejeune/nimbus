import { error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { readSession } from '$lib/server/cache/db';
import { IN_IDS, rowsByIds } from '$lib/server/cache/cache-page';
import { parseLimit, parsePage } from '$lib/pagination';
import {
	auditWhere,
	hasFilters,
	parseAuditFilters,
	targetRef,
	type TargetKind
} from '$lib/audit-filters';
import type { PageServerLoad } from './$types';

interface AuditRow {
	id: string;
	action: string;
	target: string | null;
	detail: string | null;
	/** Unix seconds; surfaced to the page as an ISO string like every other
	 *  timestamp so the UI shares one set of date formatters. */
	created_at: number;
	user_id: string | null;
	user_name: string | null;
	user_email: string | null;
}

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const page = parsePage(url.searchParams.get('page'));
	const limit = parseLimit(url.searchParams.get('limit'));
	const filters = parseAuditFilters(url.searchParams);
	const where = auditWhere(filters);
	// Read-only viewer; an entry lagging one replica tick is fine.
	const read = readSession(db);

	// One row past the page detects "next" without a second scan per request;
	// the total (under the same filters) drives the "X–Y of N" footer.
	const [{ results }, total] = await Promise.all([
		read
			.prepare(
				`SELECT a.id, a.action, a.target, a.detail, a.created_at, a.user_id,
				        u.name AS user_name, u.email AS user_email
				 FROM audit_log a
				 LEFT JOIN user u ON u.id = a.user_id
				 ${where.sql}
				 ORDER BY a.created_at DESC, a.id DESC
				 LIMIT ? OFFSET ?`
			)
			.bind(...where.binds, limit + 1, (page - 1) * limit)
			.all<AuditRow>(),
		read
			.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${where.sql}`)
			.bind(...where.binds)
			.first<{ n: number }>()
	]);

	const rows = results.slice(0, limit);

	// Resolve this page's targets to live entities in one bounded query per
	// kind; anything unresolved (deleted, renamed) renders as plain text.
	const keys: Record<TargetKind, Set<string>> = {
		cache: new Set(),
		user: new Set(),
		group: new Set(),
		token: new Set()
	};
	for (const r of rows) {
		const ref = targetRef(r.action, r.target);
		if (ref) keys[ref.kind].add(ref.key);
	}
	const [liveCaches, liveUsers, liveGroups, tokenOwners] = await Promise.all([
		rowsByIds<{ name: string }>(
			read,
			`SELECT name FROM cache WHERE deleted_at IS NULL AND name ${IN_IDS}`,
			[...keys.cache]
		),
		rowsByIds<{ id: string; name: string | null }>(
			read,
			`SELECT id, name FROM user WHERE id ${IN_IDS}`,
			[...keys.user]
		),
		rowsByIds<{ id: string; name: string }>(
			read,
			`SELECT id, name FROM groups WHERE id ${IN_IDS}`,
			[...keys.group]
		),
		rowsByIds<{ id: string; user_id: string; name: string; owner: string | null }>(
			read,
			`SELECT t.id, t.user_id, t.name, u.name AS owner FROM api_token t
			 JOIN user u ON u.id = t.user_id WHERE t.id ${IN_IDS}`,
			[...keys.token]
		)
	]);
	const cacheSet = new Set(liveCaches.map((c) => c.name));
	const userMap = new Map(liveUsers.map((u) => [u.id, u.name]));
	const groupMap = new Map(liveGroups.map((g) => [g.id, g.name]));
	const tokenMap = new Map(tokenOwners.map((t) => [t.id, t]));

	/** A link (and a friendlier label when the id has a name) for a target. */
	function resolve(action: string, target: string | null): { href: string; label: string } | null {
		const ref = targetRef(action, target);
		if (!ref) return null;
		switch (ref.kind) {
			case 'cache':
				return cacheSet.has(ref.key)
					? { href: `/caches/${encodeURIComponent(ref.key)}`, label: target! }
					: null;
			case 'user':
				return userMap.has(ref.key)
					? {
							href: `/users/${encodeURIComponent(ref.key)}`,
							label: userMap.get(ref.key) || target!
						}
					: null;
			case 'group':
				return groupMap.has(ref.key)
					? { href: `/groups/${encodeURIComponent(ref.key)}`, label: groupMap.get(ref.key)! }
					: null;
			case 'token': {
				const t = tokenMap.get(ref.key);
				return t
					? {
							href: `/users/${encodeURIComponent(t.user_id)}`,
							label: `${t.name}${t.owner ? ` (${t.owner})` : ''}`
						}
					: null;
			}
		}
	}

	return {
		page,
		pageSize: limit,
		total: total?.n ?? 0,
		hasMore: results.length > limit,
		filters,
		filtered: hasFilters(filters),
		entries: rows.map((r) => ({
			id: r.id,
			action: r.action,
			target: r.target,
			targetLink: resolve(r.action, r.target),
			detail: r.detail,
			createdAt: new Date(r.created_at * 1000).toISOString(),
			// Null for system-initiated actions and unresolvable user ids alike.
			user: r.user_name || r.user_email || null,
			userId: r.user_id
		}))
	};
};
