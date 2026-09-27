const MAX_REDIRECT_CHARS = 2048;

/** The attacker-controllable `?redirect=` target as a same-origin path, or
 * `/`. `origin` is a URL origin such as `url.origin`. */
export function safeRedirectPath(raw: string | null | undefined, origin: string): string {
	if (!raw || raw.length > MAX_REDIRECT_CHARS || !isSafePath(raw)) return '/';
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return '/';
	}
	if (url.origin !== origin) return '/';
	// URL parsing resolves dot segments: `/a/..//x` becomes `//x`.
	const path = url.pathname + url.search + url.hash;
	return isSafePath(path) ? path : '/';
}

/** One leading `/` (not `//`), no backslash or control characters — before
 * and after percent-decoding. */
function isSafePath(value: string): boolean {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return false;
	}
	return [value, decoded].every(
		(v) => v.startsWith('/') && !v.startsWith('//') && isSafePathText(v)
	);
}

// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHARS = /[\\\u0000-\u001f\u007f]/;

function isSafePathText(value: string): boolean {
	return !UNSAFE_PATH_CHARS.test(value);
}
