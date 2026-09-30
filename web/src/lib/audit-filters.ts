// Audit log filtering and target resolution, kept pure so the SQL shape and
// the action → entity mapping are testable without a database.
import { escapeLike } from '$lib/utils';

export interface AuditFilters {
	/** User ids (any of), SYSTEM_USER for entries with no acting user. */
	users: string[];
	/** Exact actions (`cache.create`) or whole families (`cache.*`), any of. */
	actions: string[];
	/** Free text matched against target and detail. */
	q: string;
}

export const SYSTEM_USER = 'system';

const ACTION_RE = /^[a-z_]+(\.[a-z_]+)*$/;
const FAMILY_RE = /^[a-z_]+\.\*$/;

/** Most values one filter takes (a URL is not a query language). */
const MAX_VALUES = 50;

const distinct = (values: string[]) =>
	[...new Set(values.map((v) => v.trim()))].filter(Boolean).slice(0, MAX_VALUES);

export function parseAuditFilters(params: URLSearchParams): AuditFilters {
	// Unknown action shapes are dropped rather than matched literally.
	const actions = distinct(params.getAll('action')).filter(
		(a) => ACTION_RE.test(a) || FAMILY_RE.test(a)
	);
	const q = (params.get('q') ?? '').trim().slice(0, 200);
	return { users: distinct(params.getAll('user')), actions, q };
}

export function hasFilters(f: AuditFilters): boolean {
	return f.users.length > 0 || f.actions.length > 0 || f.q !== '';
}

/** WHERE clause (with leading `WHERE`, or '') and its positional binds, over
 *  `audit_log a`. User input only ever travels as a bind. */
export function auditWhere(f: AuditFilters): { sql: string; binds: string[] } {
	const clauses: string[] = [];
	const binds: string[] = [];
	const ids = f.users.filter((u) => u !== SYSTEM_USER);
	const users = [
		...(ids.length ? ['a.user_id IN (SELECT value FROM json_each(?))'] : []),
		...(f.users.includes(SYSTEM_USER) ? ['a.user_id IS NULL'] : [])
	];
	if (ids.length) binds.push(JSON.stringify(ids));
	if (users.length) clauses.push(users.length > 1 ? `(${users.join(' OR ')})` : users[0]);
	const actions = f.actions.map((a) => {
		if (a.endsWith('.*')) {
			binds.push(`${escapeLike(a.slice(0, -1))}%`);
			return "a.action LIKE ? ESCAPE '\\'";
		}
		binds.push(a);
		return 'a.action = ?';
	});
	if (actions.length) clauses.push(actions.length > 1 ? `(${actions.join(' OR ')})` : actions[0]);
	if (f.q) {
		const like = `%${escapeLike(f.q)}%`;
		clauses.push("(a.target LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')");
		binds.push(like, like);
	}
	return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

/** Actions grouped by family (`cache`, `token`, …) for the filter's optgroups. */
export function groupActions(actions: string[]): { family: string; actions: string[] }[] {
	const groups = new Map<string, string[]>();
	for (const a of [...actions].sort()) {
		const family = a.split('.')[0];
		groups.set(family, [...(groups.get(family) ?? []), a]);
	}
	return [...groups].map(([family, actions]) => ({ family, actions }));
}

export type TargetKind = 'cache' | 'user' | 'group' | 'token';

/** Which entity an entry's target names, per the writeAudit call sites:
 *  cache.* carry the cache name, path.destroy `<cache>/<hash>`, user.* and
 *  group.* ids, token.* the token id (jti). Grants and upstream URLs don't
 *  resolve to a page. */
export function targetRef(
	action: string,
	target: string | null
): { kind: TargetKind; key: string } | null {
	if (!target) return null;
	const family = action.split('.')[0];
	switch (family) {
		case 'cache':
			return { kind: 'cache', key: target };
		case 'path': {
			const cache = target.split('/')[0];
			return cache ? { kind: 'cache', key: cache } : null;
		}
		case 'user':
			return { kind: 'user', key: target };
		case 'group':
			return { kind: 'group', key: target };
		case 'token':
			return { kind: 'token', key: target };
		default:
			return null;
	}
}
