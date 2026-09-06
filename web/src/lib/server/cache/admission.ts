import type { RateLimit } from '@cloudflare/workers-types';
import { errorResponse } from '../attic/http';

export class AdmissionError extends Error {
	constructor(
		message: string,
		private readonly retryAfter = 60
	) {
		super(message);
	}
	response(): Response {
		return errorResponse(503, this.message, undefined, { 'Retry-After': String(this.retryAfter) });
	}
}

/** Optional in local development; binding failures never authorize work. */
export async function takeBudget(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key })).success;
	} catch {
		return false;
	}
}

export async function requireBudget(limiter: RateLimit | undefined, key: string): Promise<void> {
	if (!(await takeBudget(limiter, key))) throw new AdmissionError('Backend work budget exhausted');
}

/** Charge several units at once. A refusal on any unit refuses the work;
 * the other units are still spent, which is what keeps the limiter honest
 * (the caller could otherwise have done the work) — and is cheaper than
 * serial takes on a hot path. */
export async function takeBudgetUnits(
	limiter: RateLimit | undefined,
	key: string,
	units: number
): Promise<boolean> {
	if (!limiter || units <= 0) return true;
	const results = await Promise.all(Array.from({ length: units }, () => takeBudget(limiter, key)));
	return results.every(Boolean);
}

export async function requireBudgetUnits(
	limiter: RateLimit | undefined,
	key: string,
	units: number
): Promise<void> {
	if (!(await takeBudgetUnits(limiter, key, units)))
		throw new AdmissionError('Backend work budget exhausted');
}

/** Per-client limiter key. A colo-wide constant key would make one abuser's
 * refusals land on every honest client in the colo, and honest cold bursts
 * (a CI fleet substituting a fresh closure) look exactly like a flood. */
export function clientKey(prefix: string, ip: string | null | undefined): string {
	return `${prefix}:${ip ?? 'unknown'}`;
}

/** Internal gateway→store header carrying the client IP so the store can
 * charge backend work per client. Never trusted from the outside: the
 * gateway overwrites it on every loopback. */
export const CLIENT_IP_HEADER = 'X-Nimbus-Client-Ip';
