// Token list filtering for /tokens, kept pure so the parsing and the SQL
// shape are testable without a database (same split as audit-filters.ts).

export const TOKEN_STATUSES = ['active', 'expired', 'revoked', 'suspended'] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

/**
 * A token's status over `api_token t` joined to its owner `user u`, the one
 * definition both the token table and the status filter use. Revoked beats
 * expired beats suspended; an expires_at of NULL or 0 never expires. The
 * owner-active test is isActiveUser (server/auth/types.ts) in SQL. Binds
 * ?1 as the current time in unix seconds.
 */
export const TOKEN_STATUS_SQL = `CASE
	WHEN t.revoked_at IS NOT NULL THEN 'revoked'
	WHEN t.expires_at > 0 AND t.expires_at < ?1 THEN 'expired'
	WHEN NOT (u.role = 'admin' OR u.status = 'active') THEN 'suspended'
	ELSE 'active' END`;

export interface TokenFilters {
	/** Any of these statuses; empty for any. */
	statuses: TokenStatus[];
	/** Owner user ids (any of); empty for everyone. From the URL only in the
	 *  everyone view; the own view sets it to the viewer. */
	users: string[];
	/** Inclusive UTC dates, YYYY-MM-DD. */
	createdFrom: string | null;
	createdTo: string | null;
	expiresFrom: string | null;
	expiresTo: string | null;
}

export const NO_TOKEN_FILTERS: TokenFilters = {
	statuses: [],
	users: [],
	createdFrom: null,
	createdTo: null,
	expiresFrom: null,
	expiresTo: null
};

const PARAMS = {
	statuses: 'status',
	users: 'user',
	createdFrom: 'created_from',
	createdTo: 'created_to',
	expiresFrom: 'expires_from',
	expiresTo: 'expires_to'
} as const satisfies Record<keyof TokenFilters, string>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_S = 86400;

/** Unix seconds at 00:00 UTC of a YYYY-MM-DD date, or null if it isn't one. */
function dayStart(date: string): number | null {
	const ms = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(ms) ? ms / 1000 : null;
}

function parseDate(raw: string | null): string | null {
	const v = raw?.trim() ?? '';
	return DATE_RE.test(v) && dayStart(v) !== null ? v : null;
}

/** Filters from the query string; unknown or malformed values are dropped.
 *  Owner and 'suspended' only apply to the everyone view: in your own view
 *  every token is yours, and your account is active. */
export function parseTokenFilters(params: URLSearchParams, everyone: boolean): TokenFilters {
	const statuses = [...new Set(params.getAll(PARAMS.statuses))].filter(
		(s): s is TokenStatus =>
			(TOKEN_STATUSES as readonly string[]).includes(s) && (everyone || s !== 'suspended')
	);
	return {
		statuses,
		users: everyone
			? [...new Set(params.getAll(PARAMS.users).map((u) => u.trim()))].filter(Boolean).slice(0, 50)
			: [],
		createdFrom: parseDate(params.get(PARAMS.createdFrom)),
		createdTo: parseDate(params.get(PARAMS.createdTo)),
		expiresFrom: parseDate(params.get(PARAMS.expiresFrom)),
		expiresTo: parseDate(params.get(PARAMS.expiresTo))
	};
}

export function hasTokenFilters(f: TokenFilters): boolean {
	return Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : v !== null));
}

/** The filters as query parameters (for links that keep them). */
export function tokenFilterParams(f: TokenFilters): URLSearchParams {
	const params = new URLSearchParams();
	for (const [key, param] of Object.entries(PARAMS) as [keyof TokenFilters, string][]) {
		const v = f[key];
		if (Array.isArray(v)) for (const item of v) params.append(param, item);
		else if (v) params.set(param, v);
	}
	return params;
}

/**
 * WHERE clause (with leading `WHERE`, or '') and its binds, over `api_token t`
 * joined to `user u`. ?1 is always the current time (TOKEN_STATUS_SQL uses
 * it too); the rest follow in order, so a caller's own binds start at
 * ?(binds.length + 1). Values only ever travel as binds.
 */
export function tokenWhere(
	f: TokenFilters,
	nowSecs: number
): { sql: string; binds: (string | number)[] } {
	const conditions: string[] = [];
	const binds: (string | number)[] = [nowSecs];
	/** Bind a value and return its placeholder. */
	const p = (v: string | number) => `?${binds.push(v)}`;
	if (f.statuses.length) {
		conditions.push(
			`${TOKEN_STATUS_SQL} IN (SELECT value FROM json_each(${p(JSON.stringify(f.statuses))}))`
		);
	}
	if (f.users.length) {
		conditions.push(`t.user_id IN (SELECT value FROM json_each(${p(JSON.stringify(f.users))}))`);
	}
	const range = (column: string, from: string | null, to: string | null) => {
		if (from) conditions.push(`${column} >= ${p(dayStart(from)!)}`);
		if (to) conditions.push(`${column} < ${p(dayStart(to)! + DAY_S)}`);
	};
	range('t.created_at', f.createdFrom, f.createdTo);
	// A token that never expires has no expiry date to fall in any range.
	if (f.expiresFrom || f.expiresTo) conditions.push('t.expires_at > 0');
	range('t.expires_at', f.expiresFrom, f.expiresTo);
	return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', binds };
}
