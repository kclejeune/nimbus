import { afterEach, expect, it, vi } from 'vitest';
import { purgeWithJournal, replayPurges } from './purge';
import { purgeTagsBestEffort } from './gc';
import type { ExecutionContext } from './platform';
import { memoryBucket } from './test-db';

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
