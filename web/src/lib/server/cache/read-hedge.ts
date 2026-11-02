import type { D1Database } from '@cloudflare/workers-types';
import { isTransientD1Error, primarySession, readSession } from './db';
import { withinMs, type ExecutionContext } from './platform';
import { d1OverloadDelay, isD1Overload } from './d1-pressure';
import { settled, valueOf } from './result';

const HEDGE_AFTER_MS = 500;
const HEDGE_INTERVAL_MS = 1_000;
const HEDGE_LEASE_MS = 60_000;
const HEDGE_POLL_MS = 250;
let active: { deadline: number } | undefined;
let nextAllowed = 0;

/** Why a speculative primary read must wait now, and how long to poll. */
function admissionWait(
	now: number,
	replicaFailed: boolean
): { reason: 'active' | 'rate' | 'overload'; delay: number } | null {
	if (active && active.deadline > now) return { reason: 'active', delay: HEDGE_POLL_MS };
	if (now < nextAllowed) return { reason: 'rate', delay: nextAllowed - now };
	// Overload defers only speculation; a failed replica still fails over.
	const overload = replicaFailed ? 0 : d1OverloadDelay();
	if (overload > 0) return { reason: 'overload', delay: Math.min(overload, HEDGE_POLL_MS) };
	return null;
}

/** SELECT-only, replica-tolerant reads. Slow replicas get one separately
 * routed primary attempt; the first successful read wins (including empty
 * results). Primary-required confirmations never use this helper. At most
 * one hedge owns a live lease and one starts per second per isolate, so an
 * outage cannot multiply every cold read against the write primary. Leases
 * expire if a request is abandoned without running its finally. No I/O
 * promise is shared across requests; the losing read stays in its own waitUntil.
 * A pending replica rechecks admission rather than forfeiting its hedge for
 * the entire request when another read briefly owns the shared budget.
 * Explicit overload pauses speculative primary reads for two seconds after
 * the latest rejection. Error-driven failover and foreground retries remain
 * available under the existing primary concurrency/start-rate limits. */
export async function hedgedReplicaRead<T>(
	db: D1Database,
	ctx: ExecutionContext | undefined,
	read: (session: D1Database) => Promise<T>
): Promise<T> {
	if (!ctx || typeof db.withSession !== 'function') return read(readSession(db));
	const startedAt = Date.now();
	const replica = settled(Promise.resolve().then(() => read(readSession(db))));
	let first = await withinMs(replica, HEDGE_AFTER_MS);
	// One log line per wait reason: admission can alternate during a burst.
	const logged = new Set<string>();
	while (true) {
		if (first?.ok) return first.value;
		if (first && !isTransientD1Error(first.error)) throw first.error;
		const now = Date.now();
		const wait = admissionWait(now, !!first);
		if (!wait) break;
		if (!logged.has(wait.reason)) {
			logged.add(wait.reason);
			console.log(
				JSON.stringify({ event: 'nimbus.d1_hedge_wait', reason: wait.reason, ms: now - startedAt })
			);
		}
		// A failed replica already has a retryable outcome. Preserve that error
		// rather than delaying a failed request or spinning on a settled promise.
		if (first) return valueOf(first);
		// Poll only this request's I/O; never await another request's primary
		// promise. Rechecking and taking the lease below have no intervening await.
		first = await withinMs(replica, wait.delay + Math.random() * 25);
	}
	const lease = { deadline: Date.now() + HEDGE_LEASE_MS };
	active = lease;
	nextAllowed = Date.now() + HEDGE_INTERVAL_MS;
	const reason = first ? 'error' : 'slow';
	const replicaOverloaded = !!first && !first.ok && isD1Overload(first.error);
	const primary = settled(Promise.resolve().then(() => read(primarySession(db)))).finally(() => {
		if (active === lease) active = undefined;
	});
	ctx.waitUntil(Promise.all([replica, primary]).then(() => {}));
	let winner: 'replica' | 'primary' | 'none' = 'none';
	try {
		const result = await Promise.any([
			replica.then((r) => ({ source: 'replica' as const, value: valueOf(r) })),
			primary.then((r) => ({ source: 'primary' as const, value: valueOf(r) }))
		]);
		winner = result.source;
		return result.value;
	} catch {
		// Preserve the replica's original error classification if both fail.
		return valueOf(await replica);
	} finally {
		console.log(
			JSON.stringify({
				event: 'nimbus.d1_hedge',
				reason,
				replicaOverloaded,
				winner,
				ms: Date.now() - startedAt
			})
		);
	}
}
