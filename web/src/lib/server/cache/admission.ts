import type { RateLimit } from '@cloudflare/workers-types';
import { errorResponse } from '../attic/http';
import { recordLimit, type LimitRoute } from './metrics';
import { limitOutcome } from '../rate-limit';

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
	return (await limitOutcome(limiter, key)) === 'allowed';
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

/** Charge new compressed storage bytes, preserving the outcome of every unit
 * so binding failures can be distinguished from exhausted budgets. These are
 * attempted reservations, not a count of successful R2 writes. */
export async function requireStorageBudget(
	limiter: RateLimit | undefined,
	bytes: number
): Promise<void> {
	const units = Math.ceil(bytes / (1024 * 1024));
	if (!limiter || units <= 0) return;
	const outcomes = await Promise.all(
		Array.from({ length: units }, () => limitOutcome(limiter, 'storage-write'))
	);
	const rejectedUnits = outcomes.filter((outcome) => outcome === 'rejected').length;
	const errorUnits = outcomes.filter((outcome) => outcome === 'error').length;
	const outcome = errorUnits > 0 ? 'error' : rejectedUnits > 0 ? 'rejected' : 'allowed';
	console.log(
		JSON.stringify({
			event: 'nimbus.storage_budget',
			outcome,
			bytes,
			units,
			allowedUnits: units - rejectedUnits - errorUnits,
			rejectedUnits,
			errorUnits
		})
	);
	if (outcome !== 'allowed') throw new AdmissionError('Storage write budget exhausted');
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

/** Every cold read spends both the caller's allowance and an aggregate colo
 * allowance. The latter bounds a distributed distinct-hash flood that can
 * stay below every individual IP budget. Internal loopbacks carry no client
 * IP and have their own fan-out controls. */
export async function requireBackendReadBudget(
	env: App.Platform['env'],
	ip: string | null | undefined
): Promise<void> {
	if (!ip) return;
	await Promise.all([
		requireBudget(env.BACKEND_READ_LIMITER, clientKey('backend-read', ip)),
		requireBudget(env.BACKEND_READ_GLOBAL_LIMITER, 'backend-read-global')
	]);
}

/** Internal gateway→store header carrying the client IP so the store can
 * charge backend work per client. Never trusted from the outside: the
 * gateway overwrites it on every loopback. */
export const CLIENT_IP_HEADER = 'X-Nimbus-Client-Ip';

const LIMIT_RETRY_AFTER_S = 10;
const LIMIT_ERROR_RETRY_AFTER_S = 5;

/** Charge one unit of a control-plane budget: null to proceed, else a 429
 * (spent) or 503 (limiter failure — fail closed) to send instead. */
export async function enforceLimit(
	env: App.Platform['env'],
	limiter: RateLimit | undefined,
	key: string,
	route: LimitRoute
): Promise<Response | null> {
	if (!limiter) return null;
	const outcome = await limitOutcome(limiter, key);
	recordLimit(env, route, outcome);
	if (outcome === 'allowed') return null;
	if (outcome === 'error') {
		return errorResponse(503, 'Request budget temporarily unavailable; retry shortly', undefined, {
			'Retry-After': String(LIMIT_ERROR_RETRY_AFTER_S)
		});
	}
	return errorResponse(429, 'Too many requests; retry shortly', undefined, {
		'Retry-After': String(LIMIT_RETRY_AFTER_S)
	});
}
