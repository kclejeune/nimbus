import type { RateLimit } from '@cloudflare/workers-types';
import { errorResponse } from './attic/http';

export type LimitOutcome = 'allowed' | 'rejected' | 'error';

/** Unbound (local dev) admits; a binding failure is 'error' so each caller
 * chooses how to fail closed. */
export async function limitOutcome(
	limiter: RateLimit | undefined,
	key: string
): Promise<LimitOutcome> {
	if (!limiter) return 'allowed';
	try {
		return (await limiter.limit({ key })).success ? 'allowed' : 'rejected';
	} catch {
		return 'error';
	}
}

/** All auth routes share a bucket so changing endpoints cannot reset the budget. */
export async function checkRateLimit(
	request: Request,
	limiter: RateLimit | undefined,
	key = request.headers.get('CF-Connecting-IP') ?? 'unknown'
): Promise<Response | null> {
	const outcome = await limitOutcome(limiter, key);
	if (outcome === 'allowed') return null;
	if (outcome === 'rejected') {
		return errorResponse(429, 'Too many requests; retry shortly', undefined, {
			'Retry-After': '60'
		});
	}
	// Do not turn a limiter outage into unlimited anonymous database writes.
	console.warn('Auth rate limiter unavailable');
	return errorResponse(503, 'Authentication temporarily unavailable', undefined, {
		'Retry-After': '60'
	});
}
