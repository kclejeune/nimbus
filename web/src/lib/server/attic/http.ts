// Response helpers shared by the attic API handlers. Errors use the reference
// server's shape — `{code, error, message}` with an ErrorKind name string — so
// stock attic clients render them correctly.

const KIND_BY_STATUS: Record<number, string> = {
	400: 'RequestError',
	401: 'Unauthorized',
	403: 'AccessError',
	404: 'NotFound',
	409: 'CacheAlreadyExists',
	500: 'InternalServerError',
	503: 'IncompleteNar'
};

export function errorResponse(status: number, message: string, kind?: string): Response {
	return new Response(
		JSON.stringify({
			code: status,
			error: kind ?? KIND_BY_STATUS[status] ?? 'InternalServerError',
			message
		}),
		{
			status,
			// Workers Caching heuristically caches bare 404s for 3 minutes, which
			// would make freshly pushed paths invisible right after a miss.
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
		}
	);
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

/** The reference server advertises public caches with this header. */
export function withVisibility(response: Response, isPublic: boolean): Response {
	if (isPublic) response.headers.set('X-Attic-Cache-Visibility', 'public');
	return response;
}

/**
 * Downstream caching policy, applied by the gateway after the internal edge
 * cache (which stores the response as emitted, behind per-request auth): a
 * private cache's narinfo/NAR must not land in shared caches beyond our
 * control, so `public` is rewritten to `private` on the way out.
 */
export function withCachePolicy(response: Response, isPublic: boolean): Response {
	const cacheControl = response.headers.get('Cache-Control');
	if (isPublic || !cacheControl || !cacheControl.includes('public')) return response;
	const rewritten = new Response(response.body, response);
	rewritten.headers.set('Cache-Control', cacheControl.replace('public', 'private'));
	return rewritten;
}
