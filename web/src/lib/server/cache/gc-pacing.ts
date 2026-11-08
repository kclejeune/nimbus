import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { sleep } from './platform';

/** Maintenance policy, not a D1 quota: leave headroom for foreground work. */
export const GC_WINDOW_MS = 10_000;
export const GC_SQL_BUDGET_MS = 1_000;
const RESOURCE_WINDOW_ERROR = /too many resources consumed within a 10 second window/i;
const pacers = new WeakMap<D1Database, GcPacer>();

export const isGcResourceError = (error: unknown): boolean =>
	RESOURCE_WINDOW_ERROR.test(String(error));

export class GcDeferred extends Error {
	constructor(
		readonly until: number,
		readonly reason: 'resources' | 'budget'
	) {
		super(`GC deferred: ${reason}`);
	}
}

/** One invocation's accounting. No promises escape to another I/O context. */
export class GcPacer {
	private recent: { at: number; ms: number }[] = [];
	private deferred: GcDeferred | undefined;
	private tail: Promise<unknown> = Promise.resolve();
	private workDepth = 0;
	readonly totals = { sqlMs: 0, rowsRead: 0, rowsWritten: 0, waitMs: 0, statements: 0 };

	constructor(
		private background = false,
		private deadline = Infinity
	) {}

	private delay(): number {
		const now = Date.now();
		this.recent = this.recent.filter((s) => s.at + GC_WINDOW_MS > now);
		let spent = this.recent.reduce((sum, s) => sum + s.ms, 0);
		if (spent < GC_SQL_BUDGET_MS) return 0;
		for (const sample of this.recent) {
			spent -= sample.ms;
			if (spent < GC_SQL_BUDGET_MS) return sample.at + GC_WINDOW_MS - now;
		}
		return 0;
	}

	get resumeAt(): number {
		return this.deferred?.until ?? Date.now() + this.delay();
	}

	check(): void {
		if (this.deferred) throw this.deferred;
	}

	checkDeadline(): void {
		this.check();
		if (this.background && Date.now() >= this.deadline) this.yield(Date.now());
	}

	/** Explicit safe boundary, including inside a larger work unit. */
	checkpoint(): void {
		this.checkDeadline();
		if (this.background && this.resumeAt > Date.now()) this.yield();
	}

	yield(until = this.resumeAt): never {
		this.deferred = new GcDeferred(Math.max(Date.now(), until), 'budget');
		throw this.deferred;
	}

	async workUnit<T>(work: () => Promise<T>): Promise<T> {
		await this.run(async () => undefined, 0);
		this.workDepth++;
		try {
			return await work();
		} finally {
			this.workDepth--;
		}
	}

	/** Serialize even Promise.all callers, so they cannot all spend the same budget. */
	run<T>(op: () => Promise<T>, statements = 1): Promise<T> {
		const result = this.tail.then(async () => {
			this.check();
			if (this.workDepth === 0) this.checkDeadline();
			const delay = this.workDepth === 0 ? this.delay() : 0;
			if (delay > 0) {
				if (this.background) this.yield(Date.now() + delay);
				this.totals.waitMs += delay;
				await sleep(delay);
			}
			this.totals.statements += statements;
			try {
				const value = await op();
				for (const item of Array.isArray(value) ? value : [value]) {
					const meta = item?.meta ?? item;
					const ms = Number(meta?.timings?.sql_duration_ms ?? meta?.duration ?? 0);
					if (ms > 0) this.recent.push({ at: Date.now(), ms });
					this.totals.sqlMs += ms;
					this.totals.rowsRead += Number(meta?.rows_read ?? 0);
					this.totals.rowsWritten += Number(meta?.rows_written ?? 0);
				}
				return value;
			} catch (error) {
				if (isGcResourceError(error)) {
					const delay = GC_WINDOW_MS + Math.random() * 5_000;
					if (this.background) {
						this.deferred = new GcDeferred(Date.now() + delay, 'resources');
						throw this.deferred;
					}
					this.totals.waitMs += delay;
					await sleep(delay);
				}
				throw error;
			}
		});
		this.tail = result.catch(() => {});
		return result;
	}
}

/** Account first() through all() so D1's SQL time and row counts are retained.
 * Unwrap statements before batch(): the native binding requires its own
 * statement objects. Sessions share this invocation's budget. */
export function pacedGcDatabase(db: D1Database, pacer: GcPacer): D1Database {
	const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const wrap = (source: D1Database): D1Database => {
		const proxy = new Proxy(source, {
			get(target, key) {
				if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
				if (key === 'batch')
					return (items: D1PreparedStatement[]) =>
						pacer.run(() => target.batch(items.map((s) => originals.get(s) ?? s)), items.length);
				if (key === 'exec') return (sql: string) => pacer.run(() => target.exec(sql));
				if (key === 'withSession')
					return (...args: Parameters<D1Database['withSession']>) =>
						wrap(target.withSession(...args) as unknown as D1Database);
				const value = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		pacers.set(proxy, pacer);
		return proxy;
	};
	const statement = (source: D1PreparedStatement): D1PreparedStatement => {
		const proxy = new Proxy(source, {
			get(target, key) {
				if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args));
				if (key === 'first')
					return async (column?: string) => {
						const { results } = await pacer.run(() => target.all<Record<string, unknown>>());
						const row = results[0];
						if (!row) return null;
						if (column === undefined) return row;
						if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
						return row[column];
					};
				const value = Reflect.get(target, key);
				return typeof value === 'function'
					? (...args: unknown[]) => pacer.run(() => value.apply(target, args))
					: value;
			}
		});
		originals.set(proxy, source);
		return proxy;
	};
	return wrap(db);
}

/** Pace before selecting victims, then commit their deletion receipts without
 * an artificial sleep while holding a reachability result. A single graph
 * walk/mutation can exceed the soft budget; the next unit then yields. */
export function gcWorkUnit<T>(db: D1Database, work: () => Promise<T>): Promise<T> {
	return pacers.get(db)?.workUnit(work) ?? work();
}

export function gcCheckpoint(db: D1Database): void {
	pacers.get(db)?.checkpoint();
}

export function gcCheckDeadline(db: D1Database): void {
	pacers.get(db)?.checkDeadline();
}
