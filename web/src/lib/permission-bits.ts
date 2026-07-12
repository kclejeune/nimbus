// Permission-bit metadata shared by the UI components and the server-side
// form parsers — the single source of truth for bit ↔ form-field ↔ label.
// Lives outside $lib/server so Svelte components can value-import it.

export type PermissionBit = 'r' | 'w' | 'd' | 'cc' | 'cr' | 'cq' | 'cd';

/** Every bit the token verifier recognizes (attic vocabulary). Used for
 *  parsing/union; grants and tokens minted from attic tooling may carry any of
 *  these, so resolution must understand them all. */
export const ALL_PERMISSION_BITS: PermissionBit[] = ['r', 'w', 'd', 'cc', 'cr', 'cq', 'cd'];

export interface PermissionBitField {
	bit: PermissionBit;
	/** Form field name used by token-issue forms (grant forms use the bit itself). */
	field: string;
	label: string;
}

/**
 * The per-cache permissions offered in the grant/token/access UIs. Deliberately
 * excludes the two attic bits that aren't per-cache concepts:
 *   - `cc` (create cache) — creating a *new* name is a global capability, open
 *     to any active user (see caches/new); not something you grant per cache.
 *   - `cq` (configure retention) — a narrower slice of `cr`; folded into
 *     "Configure", which the server already treats as covering retention.
 * Both remain recognized by the verifier for attic-token compatibility.
 * `gc` (garbage collection) is storage-wide and admin-only, so it never
 * appears here either.
 */
export const PERMISSION_BIT_FIELDS: PermissionBitField[] = [
	{ bit: 'r', field: 'pull', label: 'Pull' },
	{ bit: 'w', field: 'push', label: 'Push' },
	{ bit: 'd', field: 'delete', label: 'Delete paths' },
	{ bit: 'cr', field: 'configure_cache', label: 'Configure' },
	{ bit: 'cd', field: 'destroy_cache', label: 'Destroy cache' }
];

/** Checkbox options for grant forms, which post the bit itself as the field
 *  name (see parseGrantActions). */
export const GRANT_BIT_OPTIONS = PERMISSION_BIT_FIELDS.map(({ bit, label }) => ({
	name: bit as string,
	label
}));

/** Human label for a parsed bits object ("Pull, Push, …"; "—" when empty). */
export function formatBits(parsed: Record<string, unknown>): string {
	return (
		GRANT_BIT_OPTIONS.filter((b) => parsed[b.name] === 1)
			.map((b) => b.label)
			.join(', ') || '—'
	);
}

/** Human label for a grant row's JSON-encoded actions. */
export function formatGrantActions(actions: string): string {
	try {
		return formatBits(JSON.parse(actions));
	} catch {
		return actions;
	}
}
