// Viewport-fit page sizing for the audit table's rows-per-page default.
// The ?limit= vocabulary itself lives in $lib/pagination.

import { PAGE_SIZES } from '$lib/pagination';

/** Approximate rendered height of one .data-table row (px): py-2.5 padding,
 *  a text-sm line and the 1px border (layout.css). */
export const ROW_HEIGHT = 41;

/** Largest allowed page size whose rows fit in `availablePx`, clamped to the
 *  smallest option when even that overflows. */
export function fitPageSize(availablePx: number): number {
	const fit = Math.floor(availablePx / ROW_HEIGHT);
	let best: number = PAGE_SIZES[0];
	for (const size of PAGE_SIZES) if (size <= fit) best = size;
	return best;
}
