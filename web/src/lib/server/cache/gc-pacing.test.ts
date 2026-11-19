import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
	GcDeferred,
	GcPacer,
	GC_WRITE_BUDGET_ROWS,
	gcWorkUnit,
	pacedGcDatabase
} from './gc-pacing';
import { testDatabase } from './test-db';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const result = (duration: number) => ({ meta: { duration, rows_read: 10, rows_written: 2 } });

it('paces serialized callers using SQL time and resets the rolling window', async () => {
	const p = new GcPacer();
	await p.run(async () => result(1_000));
	const next = vi.fn(async () => result(20));
	const pending = p.run(next);
	await vi.advanceTimersByTimeAsync(9_999);
	expect(next).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	expect(p.totals).toMatchObject({ sqlMs: 1_020, rowsRead: 20, rowsWritten: 4, waitMs: 10_000 });
	await p.run(next);
	expect(next).toHaveBeenCalledTimes(2);
});

it('does not let parallel callers spend the same remaining budget', async () => {
	const p = new GcPacer();
	const calls: number[] = [];
	const work = [0, 1, 2].map((i) =>
		p.run(async () => {
			calls.push(i);
			return result(1_000);
		})
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(calls).toEqual([0]);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(calls).toEqual([0, 1]);
	await vi.advanceTimersByTimeAsync(10_000);
	await Promise.all(work);
	expect(calls).toEqual([0, 1, 2]);
});

it('defers fast write bursts even when they consume little SQL time', async () => {
	const p = new GcPacer(true);
	await p.run(async () => ({ meta: { duration: 1, rows_written: GC_WRITE_BUDGET_ROWS } }));
	const next = vi.fn(async () => result(1));
	await expect(p.run(next)).rejects.toBeInstanceOf(GcDeferred);
	expect(next).not.toHaveBeenCalled();
	expect(p.resumeAt).toBe(Date.now() + 10_000);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	{ ms: 1_000, written: 0, budgets: ['sql'] },
	{ ms: 0, written: 1_000, budgets: ['writes'] },
	{ ms: 1_000, written: 1_000, budgets: ['sql', 'writes'] }
])(
	'reports the exhausted budgets and retains the trigger snapshot: $budgets',
	async ({ ms, written, budgets }) => {
		const p = new GcPacer(true);
		await p.run(async () => ({ meta: { duration: ms, rows_written: written } }));
		expect(p.budgets).toEqual(budgets);
		await expect(p.run(async () => result(0))).rejects.toMatchObject({ reason: 'budget', budgets });
		vi.advanceTimersByTime(20_000);
		expect(p.budgets).toEqual(budgets);
	}
);

it('waits for both SQL and write pressure to age out of the rolling window', async () => {
	const p = new GcPacer();
	await p.workUnit(async () => {
		await p.run(async () => result(1_000));
		vi.advanceTimersByTime(5_000);
		await p.run(async () => ({ meta: { duration: 0, rows_written: GC_WRITE_BUDGET_ROWS } }));
	});
	const next = vi.fn(async () => result(1));
	const pending = p.run(next);
	await vi.advanceTimersByTimeAsync(5_000);
	expect(next).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(5_000);
	await pending;
	expect(next).toHaveBeenCalledOnce();
});

it.each([
	'D1 DB is overloaded. Too many resources consumed within a 10 second window',
	'D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.'
])('defers background pressure once without running more D1 work: %s', async (message) => {
	const p = new GcPacer(true);
	await expect(
		p.run(async () => {
			throw new Error(message);
		})
	).rejects.toBeInstanceOf(GcDeferred);
	expect(p.resumeAt).toBeGreaterThanOrEqual(Date.now() + 10_000);
	expect(p.resumeAt).toBeLessThanOrEqual(Date.now() + 15_000);
	const next = vi.fn();
	await expect(p.run(next)).rejects.toBeInstanceOf(GcDeferred);
	expect(next).not.toHaveBeenCalled();
});

it('keeps foreground GC resource recovery outside the short retry window', async () => {
	const p = new GcPacer();
	const error = new Error('Too many resources consumed within a 10 second window');
	const rejected = expect(
		p.run(async () => {
			throw error;
		})
	).rejects.toBe(error);
	await vi.advanceTimersByTimeAsync(15_000);
	await rejected;
	expect(p.totals.waitMs).toBeGreaterThanOrEqual(10_000);
});

it('accounts first(), bound statements, sessions, batches and exec', async () => {
	const f = testDatabase();
	try {
		const p = new GcPacer();
		const db = pacedGcDatabase(f.db, p);
		expect(await db.prepare('SELECT ?1 AS n').bind(7).first('n')).toBe(7);
		expect(await db.prepare('SELECT 1 AS n WHERE 0').first()).toBeNull();
		expect(await db.withSession().prepare('SELECT 2 AS n').first()).toEqual({ n: 2 });
		expect((await db.batch([db.prepare('SELECT ?1 AS n').bind(3)]))[0].results).toEqual([{ n: 3 }]);
		await db.exec('ANALYZE');
		expect(p.totals.statements).toBe(5);
	} finally {
		f.sqlite.close();
	}
});

it('paces before a reachability work unit, then defers the next unit', async () => {
	const f = testDatabase();
	try {
		const p = new GcPacer();
		const db = pacedGcDatabase(f.db, p);
		await gcWorkUnit(db, async () => {
			await p.run(async () => result(1_500));
			await db.prepare('SELECT 1').all();
		});
		expect(p.totals.waitMs).toBe(0);
		const next = vi.fn(async () => {});
		const pending = gcWorkUnit(db, next);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(next).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(next).toHaveBeenCalledOnce();
	} finally {
		f.sqlite.close();
	}
});

it('retains recent work across a window boundary rather than resetting the whole budget', async () => {
	const p = new GcPacer();
	await p.run(async () => result(500));
	vi.advanceTimersByTime(5_000);
	await p.run(async () => result(500));
	const third = p.run(async () => result(500));
	await vi.advanceTimersByTimeAsync(5_000);
	await third;
	const fourth = vi.fn(async () => result(500));
	const pending = p.run(fourth);
	await vi.advanceTimersByTimeAsync(4_999);
	expect(fourth).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	expect(fourth).toHaveBeenCalledOnce();
});

it('yields background work on budget without starting a pacing timer', async () => {
	const p = new GcPacer(true);
	await p.run(async () => result(1_000));
	const next = vi.fn(async () => result(1));
	await expect(p.run(next)).rejects.toBeInstanceOf(GcDeferred);
	expect(next).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it('stops new background queries at the slice deadline without a timer', async () => {
	const p = new GcPacer(true, Date.now() + 20_000);
	await p.run(async () => result(0));
	vi.advanceTimersByTime(20_000);
	const next = vi.fn(async () => result(0));
	await expect(p.run(next)).rejects.toMatchObject({ reason: 'budget', budgets: ['deadline'] });
	expect(next).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
