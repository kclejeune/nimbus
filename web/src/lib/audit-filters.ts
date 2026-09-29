// Audit log filtering and target resolution, kept pure so the SQL shape and
// the action → entity mapping are testable without a database.

export interface AuditFilters {
	/** A user id, or SYSTEM_USER for entries with no acting user. */
	user: string | null;
	/** An exact action (`cache.create`) or a whole family (`cache.*`). */
	action: string | null;
	/** Free text matched against target and detail. */
	q: string;
}

export const SYSTEM_USER = 'system';

const ACTION_RE = /^[a-z_]+(\.[a-z_]+)*$/;
const FAMILY_RE = /^[a-z_]+\.\*$/;

export function parseAuditFilters(params: URLSearchParams): AuditFilters {
	const user = params.get('user')?.trim() || null;
	const rawAction = params.get('action')?.trim() || null;
	// Unknown shapes are dropped rather than matched literally.
	const action =
		rawAction && (ACTION_RE.test(rawAction) || FAMILY_RE.test(rawAction)) ? rawAction : null;
	const q = (params.get('q') ?? '').trim().slice(0, 200);
	return { user, action, q };
}

export function hasFilters(f: AuditFilters): boolean {
	return f.user !== null || f.action !== null || f.q !== '';
}

function escapeLike(s: string): string {
	return s.replace(/[%_\\]/g, (m) => '\\' + m);
}

/** WHERE clause (with leading `WHERE`, or '') and its positional binds, over
 *  `audit_log a`. User input only ever travels as a bind. */
export function auditWhere(f: AuditFilters): { sql: string; binds: string[] } {
	const clauses: string[] = [];
	const binds: string[] = [];
	if (f.user === SYSTEM_USER) {
		clauses.push('a.user_id IS NULL');
	} else if (f.user) {
		clauses.push('a.user_id = ?');
		binds.push(f.user);
	}
	if (f.action?.endsWith('.*')) {
		clauses.push("a.action LIKE ? ESCAPE '\\'");
		binds.push(`${escapeLike(f.action.slice(0, -1))}%`);
	} else if (f.action) {
		clauses.push('a.action = ?');
		binds.push(f.action);
	}
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
