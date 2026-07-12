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
