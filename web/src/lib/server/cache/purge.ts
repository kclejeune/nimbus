import { mapConcurrent, withRetry, withR2Retry } from './platform';

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
