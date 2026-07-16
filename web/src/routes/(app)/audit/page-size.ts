// Rows-per-page vocabulary for the audit table, shared by the server load
// (?limit= validation) and the client (selector + viewport-fit default).

/** Allowed ?limit= values; anything else falls back to the default. */
export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** Approximate rendered height of one table row (px) — matches py-3 rows. */
export const ROW_HEIGHT = 41;

export function parseLimit(v: string | null): number {
	const n = Number(v);
	return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** Largest allowed page size whose rows fit in `availablePx`, clamped to the
 *  smallest option when even that overflows. */
export function fitPageSize(availablePx: number): number {
	const fit = Math.floor(availablePx / ROW_HEIGHT);
	let best: number = PAGE_SIZES[0];
	for (const size of PAGE_SIZES) if (size <= fit) best = size;
	return best;
}
