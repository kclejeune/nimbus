import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Valid cache name, attic's rule: 1–50 chars of letters, digits, `-`, `_`,
 * and `+`, not starting with punctuation. Case-sensitive. */
export const CACHE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,49}$/;

/** Escape LIKE wildcards (for `ESCAPE '\\'`) so a term matches literally. */
export function escapeLike(s: string): string {
	return s.replace(/[%_\\]/g, (m) => '\\' + m);
}

/** A multi-value query parameter (`?user=a&user=b`): trimmed, deduplicated,
 *  empties dropped, and capped (a URL is not a query language). */
export function distinctParams(params: URLSearchParams, key: string, max = 50): string[] {
	return [...new Set(params.getAll(key).map((v) => v.trim()))].filter(Boolean).slice(0, max);
}

export const CACHE_NAME_HINT = 'Letters, digits, and - _ +, up to 50 characters.';

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
