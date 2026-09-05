import type { RateLimit } from '@cloudflare/workers-types';
import { errorResponse } from './attic/http';

/** All auth routes share a bucket so changing endpoints cannot reset the budget. */
export async function checkRateLimit(
	request: Request,
	limiter: RateLimit | undefined,
	key = request.headers.get('CF-Connecting-IP') ?? 'unknown'
): Promise<Response | null> {
	if (!limiter) return null;
	try {
		const { success } = await limiter.limit({ key });
		return success
			? null
			: errorResponse(429, 'Too many requests; retry shortly', undefined, { 'Retry-After': '60' });
	} catch {
		// Do not turn a limiter outage into unlimited anonymous database writes.
		console.warn('Auth rate limiter unavailable');
		return errorResponse(503, 'Authentication temporarily unavailable', undefined, {
			'Retry-After': '60'
		});
	}
}
