// Permission-bit metadata shared by the UI components and the server-side
// form parsers — the single source of truth for bit ↔ form-field ↔ label.
// Lives outside $lib/server so Svelte components can value-import it.

export type PermissionBit = 'r' | 'w' | 'd' | 'cc' | 'cr' | 'cq' | 'cd';

export interface PermissionBitField {
	bit: PermissionBit;
	/** Form field name used by token-issue forms (grant forms use the bit itself). */
	field: string;
	label: string;
}

export const PERMISSION_BIT_FIELDS: PermissionBitField[] = [
	{ bit: 'r', field: 'pull', label: 'Pull' },
	{ bit: 'w', field: 'push', label: 'Push' },
	{ bit: 'd', field: 'delete', label: 'Delete paths' },
	{ bit: 'cc', field: 'create_cache', label: 'Create cache' },
	{ bit: 'cr', field: 'configure_cache', label: 'Configure' },
	{ bit: 'cq', field: 'configure_retention', label: 'Retention' },
	{ bit: 'cd', field: 'destroy_cache', label: 'Destroy cache' }
];

export const GC_LABEL = 'Trigger GC';
