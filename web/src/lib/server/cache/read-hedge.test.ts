import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { ExecutionContext } from './platform';
let hedge: typeof import('./read-hedge').hedgedReplicaRead;
beforeEach(async () => {
	vi.resetModules();
	hedge = (await import('./read-hedge')).hedgedReplicaRead;
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function source() {
	const replica = {} as D1Database;
	const primary = {} as D1Database;
	const withSession = vi.fn((constraint: string) =>
		constraint === 'first-primary' ? primary : replica
	);
	const db = { withSession } as unknown as D1Database;
	const tasks: Promise<unknown>[] = [];
	const ctx = { waitUntil: (task: Promise<unknown>) => void tasks.push(task) } as ExecutionContext;
	return { db, replica, primary, ctx, tasks, withSession };
}

it('returns a fast empty replica result without a primary read or background work', async () => {
	const { db, ctx, withSession, tasks } = source();
	expect(await hedge(db, ctx, async () => [])).toEqual([]);
	await vi.advanceTimersByTimeAsync(1000);
	expect(withSession.mock.calls).toEqual([['first-unconstrained']]);
	expect(tasks).toEqual([]);
});

it('lets a fast primary beat a stalled replica and keeps the loser in the originating request', async () => {
	const { db, ctx, primary, tasks, withSession } = source();
	const stalled = deferred<string>();
	const result = hedge(db, ctx, async (session) =>
		session === primary ? 'current' : stalled.promise
	);
	await vi.advanceTimersByTimeAsync(499);
	expect(withSession).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(await result).toBe('current');
	expect(withSession).toHaveBeenCalledWith('first-primary');
	expect(tasks).toHaveLength(1);
	stalled.resolve('older');
	await Promise.all(tasks);
});

it('still accepts the replica when a primary hedge fails', async () => {
	const { db, ctx, primary, tasks } = source();
	const pending = deferred<string>();
	const result = hedge(db, ctx, async (session) => {
		if (session === primary) throw new Error('primary unavailable');
		return pending.promise;
	});
	await vi.advanceTimersByTimeAsync(500);
	pending.resolve('replica');
	expect(await result).toBe('replica');
	await Promise.all(tasks);
});

it('caps concurrent hedges and their start rate without sharing request promises', async () => {
	const { db, ctx, primary, tasks, withSession } = source();
	const replicaA = deferred<string>(),
		replicaB = deferred<string>(),
		primaryA = deferred<string>();
	const a = hedge(db, ctx, (session) =>
		session === primary ? primaryA.promise : replicaA.promise
	);
	const b = hedge(db, ctx, () => replicaB.promise);
	await vi.advanceTimersByTimeAsync(500);
	expect(
		withSession.mock.calls.filter(([constraint]) => constraint === 'first-primary')
	).toHaveLength(1);
	primaryA.resolve('primary A');
	replicaA.resolve('replica A');
	replicaB.resolve('replica B');
	await Promise.all([a, b, ...tasks]);
	const replicaC = deferred<string>();
	const c = hedge(db, ctx, () => replicaC.promise);
	await vi.advanceTimersByTimeAsync(500);
	expect(
		withSession.mock.calls.filter(([constraint]) => constraint === 'first-primary')
	).toHaveLength(1);
	replicaC.resolve('replica C');
	await c;
});

it('does not turn query errors into fallback results', async () => {
	const { db, ctx, withSession } = source();
	await expect(
		hedge(db, ctx, async () => {
			throw new Error('no such column');
		})
	).rejects.toThrow('no such column');
	expect(withSession).toHaveBeenCalledTimes(1);
});

it('recovers an abandoned lease without letting its late completion clear a newer lease', async () => {
	const { db, ctx, primary, tasks, withSession } = source();
	const replicaA = deferred<string>(),
		primaryA = deferred<string>();
	const a = hedge(db, ctx, (session) =>
		session === primary ? primaryA.promise : replicaA.promise
	);
	await vi.advanceTimersByTimeAsync(500);
	replicaA.resolve('replica A');
	await a;
	// The primary's request can disappear before finally runs in Workers.
	await vi.advanceTimersByTimeAsync(60_000);
	const replicaB = deferred<string>(),
		primaryB = deferred<string>();
	const b = hedge(db, ctx, (session) =>
		session === primary ? primaryB.promise : replicaB.promise
	);
	await vi.advanceTimersByTimeAsync(500);
	expect(
		withSession.mock.calls.filter(([constraint]) => constraint === 'first-primary')
	).toHaveLength(2);
	primaryA.resolve('late primary A');
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(1_000);
	const replicaC = deferred<string>();
	const c = hedge(db, ctx, () => replicaC.promise);
	await vi.advanceTimersByTimeAsync(500);
	expect(
		withSession.mock.calls.filter(([constraint]) => constraint === 'first-primary')
	).toHaveLength(2);
	primaryB.resolve('primary B');
	replicaB.resolve('replica B');
	replicaC.resolve('replica C');
	await Promise.all([b, c, ...tasks]);
});

it('preserves the original transient error when neither source succeeds', async () => {
	const { db, ctx, tasks } = source();
	const failure = new Error('D1_ERROR: Replica disconnected from primary');
	await expect(
		hedge(db, ctx, async () => {
			throw failure;
		})
	).rejects.toBe(failure);
	await Promise.all(tasks);
});
