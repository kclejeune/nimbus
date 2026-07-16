// Query-param vocabulary shared by the paginated tables (audit, /paths).

/** Allowed ?limit= values; anything else falls back to the default. */
export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export function parseLimit(v: string | null): number {
	const n = Number(v);
	return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** ?page= → 1-based page number; anything unparsable is page 1. */
export function parsePage(v: string | null): number {
	return Math.max(1, Math.floor(Number(v)) || 1);
}
