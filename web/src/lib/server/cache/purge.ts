import { mapConcurrent, sleep, withRetry, withR2Retry } from './platform';

type Env = App.Platform['env'];
type Purge = (tags: string[]) => Promise<void>;
const PREFIX = '_nimbus/pending-purge/';
/** Tags per ctx.cache.purge call, a Cloudflare limit. */
export const PURGE_TAG_LIMIT = 100;
/** Journal entries considered per scheduled replay. */
const REPLAY_ENTRY_LIMIT = 100;

/**
 * Purge with retries; only a batch that still fails after the last attempt is
 * journaled to R2 — once — for scheduled replay. Successful reads and purges
 * never touch R2. The error propagates so the caller can log it.
 */
export async function purgeWithJournal(env: Env, tags: string[], purge: Purge): Promise<void> {
	try {
		await withRetry(() => purge(tags), { attempts: 3, baseMs: 1000 });
	} catch (error) {
		const key = `${PREFIX}${Date.now()}-${crypto.randomUUID()}`;
		await withR2Retry(() => env.CACHE_BUCKET.put(key, JSON.stringify(tags)));
		throw error;
	}
}

/**
 * Bounded cron replay. Pending entries are coalesced into purge calls of at
 * most PURGE_TAG_LIMIT distinct tags, so a burst of failed per-upload purges
 * replays as a few calls rather than one per entry. An entry is deleted once
 * every tag it carries has been purged by a successful call, so progress
 * survives a later failure. The first failure stops the replay (the cause
 * is usually systemic — the Free-tier purge rate limit Workers Caching is
 * held to — and hammering the remaining entries would only extend the
 * outage), leaving the uncovered entries for the next run.
 */
export async function replayPurges(env: Env, purge: Purge): Promise<void> {
	const pending = await env.CACHE_BUCKET.list({ prefix: PREFIX, limit: REPLAY_ENTRY_LIMIT });
	const retired: string[] = [];
	const loaded = await mapConcurrent(pending.objects, 10, async ({ key }) => {
		const object = await env.CACHE_BUCKET.get(key);
		if (!object) return null;
		try {
			return { key, tags: await object.json<string[]>() };
		} catch {
			// Unparseable journal entry: nothing can ever replay it.
			retired.push(key);
			return null;
		}
	});
	const entries = loaded.filter((e) => e !== null);
	// Entries in journal order, tags ordered by first appearance, so early
	// batches cover early entries and each success retires whole entries.
	const tags = [...new Set(entries.flatMap((e) => e.tags))];
	const purged = new Set<string>();
	try {
		for (let i = 0; i < tags.length; i += PURGE_TAG_LIMIT) {
			const batch = tags.slice(i, i + PURGE_TAG_LIMIT);
			await purge(batch);
			for (const tag of batch) purged.add(tag);
		}
	} finally {
		for (const entry of entries) {
			if (entry.tags.every((tag) => purged.has(tag))) retired.push(entry.key);
		}
		if (retired.length > 0) await env.CACHE_BUCKET.delete(retired);
	}
}

// Per-isolate purge coalescing for the upload path. A push lands hundreds of
// paths on one isolate within seconds and each used to issue its own purge
// call (four tags), against a purge API that is rate limited on this plan.
// Callers park their tags, wait out a short window on their own timer, and
// whichever waiter wakes first with no live leader flushes everything parked
// in PURGE_TAG_LIMIT batches; the rest poll a flushed watermark. Polling
// rather than sharing the leader's promise: on Workers a promise settled
// from another request's I/O context cancels the waiter's continuation (see
// Semaphore in platform.ts). Leadership is an owned lease, not a flag: a
// leader whose request context is torn down mid-flush never reaches its
// finally, so followers take over once the lease lapses, and a superseded
// leader that later returns must not release its successor's lease. Parked
// tags carry the generation of their latest enqueue and leave only when that
// generation was attempted: a tag re-parked while its purge is in flight is
// a new obligation (the entry may have been repopulated in between), and a
// dead leader's tags are re-flushed rather than lost.
const COALESCE_WINDOW_MS = 250;
const COALESCE_POLL_MS = 25;
/** Longer than a healthy flush (a batch is ~100 ms; retries add seconds),
 * shorter than the waitUntil budget so a follower can still take over. */
const COALESCE_LEASE_MS = 15_000;
const COALESCE_WAIT_MS = 25_000;
const parked = new Map<string, number>();
let parkedSeq = 0;
let flushedSeq = 0;
let leaseSeq = 0;
let leaseOwner = 0;
let leaseUntil = 0;

/**
 * Purge `tags` together with whatever else this isolate parks within the
 * window. Resolves once a flush covering the tags was attempted; a batch
 * that failed has been journaled by the purge itself (purgeWithJournal), so
 * followers treat the covered watermark as done and only the leader sees the
 * error.
 */
export async function purgeCoalesced(purge: Purge, tags: string[]): Promise<void> {
	const mine = ++parkedSeq;
	for (const tag of tags) parked.set(tag, mine);
	await sleep(COALESCE_WINDOW_MS);
	const deadline = Date.now() + COALESCE_WAIT_MS;
	while (flushedSeq < mine) {
		if (Date.now() >= leaseUntil) {
			const lease = ++leaseSeq;
			leaseOwner = lease;
			leaseUntil = Date.now() + COALESCE_LEASE_MS;
			const covered = parkedSeq;
			try {
				await flushParked(purge);
			} finally {
				flushedSeq = Math.max(flushedSeq, covered);
				if (leaseOwner === lease) leaseUntil = 0;
			}
			return;
		}
		if (Date.now() > deadline) throw new Error('purge coalescing: flush wait timed out');
		await sleep(COALESCE_POLL_MS + Math.random() * COALESCE_POLL_MS);
	}
}

/** Every batch is attempted even when an earlier one failed; the first
 * error is rethrown afterwards. */
async function flushParked(purge: Purge): Promise<void> {
	const entries = [...parked];
	let failure: unknown;
	for (let i = 0; i < entries.length; i += PURGE_TAG_LIMIT) {
		const batch = entries.slice(i, i + PURGE_TAG_LIMIT);
		try {
			await purge(batch.map(([tag]) => tag));
		} catch (e) {
			failure ??= e;
		}
		for (const [tag, generation] of batch) {
			if (parked.get(tag) === generation) parked.delete(tag);
		}
	}
	if (failure !== undefined) throw failure;
}
