import { afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from './test-db';
import type { D1Database } from '@cloudflare/workers-types';
import type { ExecutionContext } from './platform';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('recovers a stalled upload dedup probe with a SELECT and leaves holds untouched', async () => {
	vi.resetModules();
	const { probeNar, tryLockNarProbed } = await import('./upload');
	const fixture = testDatabase();
	const hash = `sha256:${'a'.repeat(64)}`;
	fixture.sqlite
		.prepare(
			"INSERT INTO nar (state,nar_hash,nar_size,created_at) VALUES ('V',?,3,datetime('now'))"
		)
		.run(hash);
	let finish!: (result: { results: never[] }) => void;
	const stalled = new Promise<{ results: never[] }>((resolve) => (finish = resolve));
	const replica = {
		prepare: () => ({ bind: () => ({ all: () => stalled }) })
	} as unknown as D1Database;
	const sessions = vi
		.spyOn(fixture.db, 'withSession')
		.mockImplementation(
			(constraint) => (constraint === 'first-primary' ? fixture.db : replica) as never
		);
	const tasks: Promise<unknown>[] = [];
	const ctx = { waitUntil: (task: Promise<unknown>) => void tasks.push(task) } as ExecutionContext;
	const env = { ATTIC_DB: fixture.db } as App.Platform['env'];
	vi.useFakeTimers();
	try {
		const before = fixture.totalChanges();
		const probe = probeNar(env, hash, ctx);
		await vi.advanceTimersByTimeAsync(500);
		expect(await probe).toMatchObject({ nar_hash: hash });
		expect(sessions).toHaveBeenCalledWith('first-primary');
		expect(fixture.totalChanges()).toBe(before);
		// A successful read is still only a probe: the normal authoritative
		// hold acquisition must run before deduplicated publication.
		expect(await tryLockNarProbed(env, hash, probe)).toMatchObject({ nar_hash: hash });
		expect(fixture.sqlite.prepare('SELECT holders_count FROM nar').get()).toMatchObject({
			holders_count: 1
		});
	} finally {
		finish({ results: [] });
		await Promise.all(tasks);
		fixture.sqlite.close();
	}
});
