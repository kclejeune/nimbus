import { goto } from '$app/navigation';

/**
 * Apply a list or chart page's URL-driven state (filters, sort, window) in
 * place: the load re-runs, but no history entry is added and focus and
 * scroll stay put, so typing in a filter box isn't interrupted. Accepts a
 * query string with or without its `?`.
 */
export function replaceQuery(query: URLSearchParams | string): Promise<void> {
	const qs = String(query).replace(/^\?/, '');
	return goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
}
