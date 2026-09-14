import { afterEach, expect, it, vi } from 'vitest';
import { PURGE_TAG_LIMIT, purgeCoalesced, purgeWithJournal, replayPurges } from './purge';
import { purgeTagsBestEffort } from './gc';
import type { ExecutionContext } from './platform';
import { memoryBucket } from './test-db';
import { sleep } from './platform';

afterEach(() => vi.useRealTimers());

/** Drive a call through its retry backoff under fake timers. */
async function settled<T>(run: () => Promise<T>): Promise<T> {
	vi.useFakeTimers();
	const pending = run();
	pending.catch(() => {});
	await vi.advanceTimersByTimeAsync(30_000);
	return pending;
}

/** A bucket holding the given journal entries (key → tags). */
function bucket(pending: Record<string, string[]>) {
	const { objects, bucket } = memoryBucket(
		new Map(
			Object.entries(pending).map(([key, tags]) => [
				key,
				new TextEncoder().encode(JSON.stringify(tags))
			])
		)
	);
	const env = { CACHE_BUCKET: bucket } as unknown as App.Platform['env'];
	return { env, objects, put: bucket.put, remove: bucket.delete };
}

it('retries before journaling, and journals a final failure exactly once', async () => {
	const { env, put } = bucket({});
	const ok = vi.fn(async () => {});
	await purgeWithJournal(env, ['tag'], ok);
	expect(ok).toHaveBeenCalledOnce();
	expect(put).not.toHaveBeenCalled();

	const failed = vi.fn(async () => {
		throw new Error('purge rejected');
	});
	await expect(settled(() => purgeWithJournal(env, ['tag'], failed))).rejects.toThrow(
		'purge rejected'
	);
	expect(failed).toHaveBeenCalledTimes(3);
	expect(put).toHaveBeenCalledOnce();

	let calls = 0;
	const flaky = vi.fn(async () => {
		if (++calls < 2) throw new Error('rate limited');
	});
	await settled(() => purgeWithJournal(env, ['tag'], flaky));
	expect(flaky).toHaveBeenCalledTimes(2);
	expect(put).toHaveBeenCalledOnce();
});

it('replays pending entries as coalesced purges and deletes them only on success', async () => {
	const pending: Record<string, string[]> = {};
	for (let i = 0; i < 150; i++) pending[`_nimbus/pending-purge/${i}`] = [`t${i}`, 'shared'];
	const { env, objects, remove } = bucket(pending);

	const failed = vi.fn(async () => {
		throw new Error('purge rejected');
	});
	await expect(replayPurges(env, failed)).rejects.toThrow('purge rejected');
	expect(failed).toHaveBeenCalledOnce();
	expect(remove).not.toHaveBeenCalled();
	expect(objects.size).toBe(150);

	const purge = vi.fn(async (_tags: string[]) => {});
	await replayPurges(env, purge);
	// 101 distinct tags across the 100 entries considered → two purge calls
	// of at most 100 tags, not one call per journal entry.
	expect(purge).toHaveBeenCalledTimes(2);
	expect(purge.mock.calls.flatMap(([tags]) => tags)).toHaveLength(101);
	for (const [tags] of purge.mock.calls) expect(tags.length).toBeLessThanOrEqual(100);
	// Retired entries go in one delete call, not one per entry.
	expect(remove).toHaveBeenCalledOnce();
	expect(objects.size).toBe(50);
});

it('keeps replay progress when a later batch fails', async () => {
	const pending: Record<string, string[]> = {};
	for (let i = 0; i < 100; i++) pending[`_nimbus/pending-purge/${i}`] = [`t${i}`, 'shared'];
	const { env, objects } = bucket(pending);
	let calls = 0;
	const purge = vi.fn(async () => {
		if (++calls === 2) throw new Error('rate limited');
	});
	await expect(replayPurges(env, purge)).rejects.toThrow('rate limited');
	// First batch (t0..t98 + shared) succeeded: those 99 entries are retired;
	// only the entry carrying t99 waits for the next run.
	expect([...objects.keys()]).toEqual(['_nimbus/pending-purge/99']);
});

it('routine purges name specific tags and never the global candidates tag', async () => {
	const purgeTags = vi.fn(async (_tags: string[]) => {});
	const ctx = { exports: { CachedStore: { purgeTags } } } as unknown as ExecutionContext;
	await purgeTagsBestEffort(ctx, ['narinfo:a', 'candidate:path:b', 'narinfo:a']);
	expect(purgeTags).toHaveBeenCalledOnce();
	expect(purgeTags.mock.calls[0][0]).toEqual(['narinfo:a', 'candidate:path:b']);
});

it('coalesces concurrent purges into batched calls and settles every caller', async () => {
	vi.useFakeTimers();
	const purge = vi.fn(async (_tags: string[]) => {});
	const callers = Array.from({ length: 150 }, (_, i) =>
		purgeCoalesced(purge, [`tag-${i}`, 'shared'])
	);
	await vi.advanceTimersByTimeAsync(1_000);
	await Promise.all(callers);
	// 151 distinct tags: two calls, none over the per-call limit.
	expect(purge).toHaveBeenCalledTimes(2);
	const sent = purge.mock.calls.flatMap(([tags]) => tags);
	expect(purge.mock.calls.every(([tags]) => tags.length <= PURGE_TAG_LIMIT)).toBe(true);
	expect(new Set(sent).size).toBe(151);
	expect(sent).toContain('shared');

	// A later call after the window closed flushes on its own.
	const late = purgeCoalesced(purge, ['late']);
	await vi.advanceTimersByTimeAsync(1_000);
	await late;
	expect(purge).toHaveBeenCalledTimes(3);
	expect(purge.mock.lastCall?.[0]).toEqual(['late']);
});

it('takes over from a leader whose request died mid-flush without losing its tags', async () => {
	vi.useFakeTimers();
	let calls = 0;
	const purge = vi.fn(async (_tags: string[]) => {
		// The first leader's context is torn down: its purge never settles.
		if (calls++ === 0) return new Promise<void>(() => {});
	});
	const dead = purgeCoalesced(purge, ['from-dead-leader']);
	dead.catch(() => {});
	await vi.advanceTimersByTimeAsync(300);
	expect(purge).toHaveBeenCalledTimes(1);
	const follower = purgeCoalesced(purge, ['from-follower']);
	await vi.advanceTimersByTimeAsync(20_000);
	await follower;
	expect(purge).toHaveBeenCalledTimes(2);
	expect(purge.mock.lastCall?.[0]).toEqual(
		expect.arrayContaining(['from-dead-leader', 'from-follower'])
	);
});

it('re-purges a tag parked again while its earlier purge was in flight', async () => {
	vi.useFakeTimers();
	let release!: () => void;
	const purge = vi.fn(async (_tags: string[]) => {
		if (purge.mock.calls.length === 1) await new Promise<void>((r) => (release = r));
	});
	const first = purgeCoalesced(purge, ['tag']);
	await vi.advanceTimersByTimeAsync(300);
	expect(purge).toHaveBeenCalledTimes(1);
	// Re-parked while the leader's purge is awaiting its RPC: the entry may
	// have been repopulated since the leader snapshotted it.
	const second = purgeCoalesced(purge, ['tag']);
	await vi.advanceTimersByTimeAsync(300);
	release();
	await vi.advanceTimersByTimeAsync(500);
	await first;
	await second;
	expect(purge).toHaveBeenCalledTimes(2);
});

it("does not let a superseded slow leader release its successor's lease", async () => {
	vi.useFakeTimers();
	const durations = [16_000, 4_000];
	const purge = vi.fn(async (_tags: string[]) => {
		await sleep(durations[purge.mock.calls.length - 1] ?? 0);
	});
	const slow = purgeCoalesced(purge, ['slow']);
	await vi.advanceTimersByTimeAsync(1_000);
	const successor = purgeCoalesced(purge, ['successor']);
	// The lease lapses at 15.25 s; the successor takes over and flushes.
	await vi.advanceTimersByTimeAsync(15_000);
	expect(purge).toHaveBeenCalledTimes(2);
	// The slow leader returns at 16.25 s. Its finally must not clear the
	// successor's lease, so a third caller waits instead of starting an
	// overlapping flush.
	const third = purgeCoalesced(purge, ['third']);
	await vi.advanceTimersByTimeAsync(2_000);
	expect(purge).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(5_000);
	await Promise.all([slow, successor, third]);
	expect(purge).toHaveBeenCalledTimes(3);
	expect(purge.mock.calls[2][0]).toEqual(['third']);
});
