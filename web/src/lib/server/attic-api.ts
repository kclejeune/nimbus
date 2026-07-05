import { mintAtticToken, type CacheAccess } from './attic-token';

type Env = App.Platform['env'];

/**
 * Call the attic API worker over the service binding, authenticated with a
 * freshly minted attic JWT scoped to `caches`. The browser never sees this
 * token — it stays server-to-server.
 */
export async function atticFetch(
	env: Env,
	acting: { userId: string; caches: CacheAccess },
	path: string,
	init: RequestInit = {}
): Promise<Response> {
	if (!env.JWT_HS256_SECRET_BASE64) {
		throw new Error('JWT_HS256_SECRET_BASE64 is not configured');
	}

	const token = await mintAtticToken(env.JWT_HS256_SECRET_BASE64, acting.userId, acting.caches);

	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${token}`);

	// The URL host is irrelevant for a service binding; the request is routed to
	// the bound worker directly.
	const url = `https://attic-api${path}`;
	return env.ATTIC_API.fetch(new Request(url, { ...init, headers }) as never) as unknown as Response;
}

/** Grant full admin over all caches (wildcard) — for privileged admin actions. */
export function adminAccess(): CacheAccess {
	return { '*': { r: 1, w: 1, d: 1, cc: 1, cr: 1, cq: 1, cd: 1 } };
}
