import type { D1Database } from '@cloudflare/workers-types';
import { isTransientD1Error, primarySession, readSession } from './db';
import { withinMs, type ExecutionContext } from './platform';

const HEDGE_AFTER_MS = 500;
const HEDGE_INTERVAL_MS = 1_000;
const HEDGE_LEASE_MS = 60_000;
const HEDGE_POLL_MS = 250;
let active: { deadline: number } | undefined;
let nextAllowed = 0;

type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settled = <T>(work: Promise<T>): Promise<Result<T>> =>
	work.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error })
	);
const valueOf = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

/** SELECT-only, replica-tolerant reads. Slow replicas get one separately
 * routed primary attempt; the first successful read wins (including empty
 * results). Primary-required confirmations never use this helper. At most
 * one hedge owns a live lease and one starts per second per isolate, so an
 * outage cannot multiply every cold read against the write primary. Leases
 * expire if a request is abandoned without running its finally. No I/O
 * promise is shared across requests; the losing read stays in its own waitUntil.
 * A pending replica rechecks admission rather than forfeiting its hedge for
 * the entire request when another read briefly owns the shared budget. */
export async function hedgedReplicaRead<T>(
	db: D1Database,
	ctx: ExecutionContext | undefined,
	read: (session: D1Database) => Promise<T>
): Promise<T> {
	if (!ctx || typeof db.withSession !== 'function') return read(readSession(db));
	const startedAt = Date.now();
	const replica = settled(Promise.resolve().then(() => read(readSession(db))));
	let first = await withinMs(replica, HEDGE_AFTER_MS);
	let blocked: 'active' | 'rate' | undefined;
	while (true) {
		if (first?.ok) return first.value;
		if (first && !isTransientD1Error(first.error)) throw first.error;
		const now = Date.now();
		const reason = active && active.deadline > now ? 'active' : now < nextAllowed ? 'rate' : null;
		if (!reason) break;
		if (!blocked) {
			blocked = reason;
			console.log(JSON.stringify({ event: 'nimbus.d1_hedge_wait', reason, ms: now - startedAt }));
		}
		// A failed replica already has a retryable outcome. Preserve that error
		// rather than delaying a failed request or spinning on a settled promise.
		if (first) return valueOf(first);
		// Poll only this request's I/O; never await another request's primary
		// promise. Rechecking and taking the lease below have no intervening await.
		const delay = reason === 'rate' ? nextAllowed - now : HEDGE_POLL_MS;
		first = await withinMs(replica, delay + Math.random() * 25);
	}
	const lease = { deadline: Date.now() + HEDGE_LEASE_MS };
	active = lease;
	nextAllowed = Date.now() + HEDGE_INTERVAL_MS;
	const reason = first ? 'error' : 'slow';
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
			JSON.stringify({ event: 'nimbus.d1_hedge', reason, winner, ms: Date.now() - startedAt })
		);
	}
}
