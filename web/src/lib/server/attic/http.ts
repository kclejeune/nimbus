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
			headers: { 'Content-Type': 'application/json' }
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
