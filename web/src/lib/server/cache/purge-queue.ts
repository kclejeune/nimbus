import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { PURGE_TAG_LIMIT } from './purge';

/** Pacing is shared by one Durable Object for the entire Worker, including
 * urgent purges. Leave rate-limit recovery headroom for other account users. */
export const PURGE_INTERVAL_MS = 12_000;
export const PURGE_COOLDOWN_MS = 60_000;
const BATCH_WINDOW_MS = 250;
export interface PurgeResult {
	success: boolean;
	rateLimited?: boolean;
}
type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync' | 'setAlarm' | 'deleteAlarm'>;
/** A scheduled repair runs only once none of its page's tags are pending, so
 * the alarm (arm) and the runner (runRepairs) must agree on this exactly. */
const REPAIR_UNBLOCKED = 'NOT EXISTS (SELECT 1 FROM repair_tag t WHERE t.key = s.key)';
type Pending = { tag: string; generation: number };

/** SQLite operations and alarms make enqueue/retire crash-safe. No I/O promise
 * is shared between invocations. An alarm remains armed while a purge is in
 * flight; an ambiguous outcome is retried, never assumed successful. */
export class PurgeQueue {
	private flight: { until: number } | undefined;
	constructor(
		private storage: Storage,
		private purge: (tags: string[]) => Promise<PurgeResult>,
		private resumeRepair?: (key: string) => Promise<number | null>
	) {
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending_purge (
			tag TEXT PRIMARY KEY, generation INTEGER NOT NULL, queued_at INTEGER NOT NULL,
			urgent INTEGER NOT NULL)`);
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS purge_clock (
			id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL, next_at INTEGER NOT NULL)`);
		storage.sql.exec('INSERT OR IGNORE INTO purge_clock VALUES (1, 0, 0)');
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS repair_schedule (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL)'
		);
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS repair_receipt (key TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (key, receipt))'
		);
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS repair_tag (key TEXT NOT NULL, receipt TEXT NOT NULL, tag TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY (key, receipt, tag))'
		);
		storage.sql.exec(
			'CREATE INDEX IF NOT EXISTS repair_tag_generation ON repair_tag(tag, generation)'
		);
	}

	async enqueue(tags: string[], urgent = false): Promise<{ confirmed: boolean }> {
		const unique = [...new Set(tags)];
		if (!unique.length) return { confirmed: true };
		this.storage.transactionSync(() => this.stage(unique, urgent));
		// Await storage before acknowledging receipt. Uploads need durable queueing;
		// deletion/repair callers additionally need a confirmed cache eviction.
		await this.arm();
		if (!urgent) return { confirmed: false };
		await this.flush();
		const { remaining } = this.storage.sql
			.exec<{ remaining: number }>(
				'SELECT COUNT(*) AS remaining FROM pending_purge WHERE tag IN (SELECT value FROM json_each(?))',
				JSON.stringify(unique)
			)
			.one();
		return { confirmed: remaining === 0 };
	}

	/** Idempotent page submission. Completed receipts survive until the D1 job
	 * retires, including a lost D1 cursor-update response or DO restart. */
	async repairPurge(key: string, receipt: string, tags: string[]): Promise<boolean> {
		this.storage.transactionSync(() => {
			if (
				this.storage.sql
					.exec('SELECT 1 FROM repair_receipt WHERE key = ? AND receipt = ?', key, receipt)
					.toArray().length
			)
				return;
			this.storage.sql.exec('INSERT INTO repair_receipt VALUES (?, ?)', key, receipt);
			const unique = [...new Set(tags)];
			const generation = this.stage(unique, false);
			for (const tag of unique) {
				this.storage.sql.exec(
					'INSERT INTO repair_tag VALUES (?, ?, ?, ?)',
					key,
					receipt,
					tag,
					generation
				);
			}
		});
		await this.arm();
		return (
			this.storage.sql
				.exec('SELECT 1 FROM repair_tag WHERE key = ? AND receipt = ? LIMIT 1', key, receipt)
				.toArray().length === 0
		);
	}

	/** Upsert `tags` under a fresh generation (callers hold a transaction), so a
	 * purge already in flight cannot retire a re-enqueued tag. */
	private stage(tags: string[], urgent: boolean): number {
		const { generation } = this.storage.sql
			.exec<{ generation: number }>(
				'UPDATE purge_clock SET generation = generation + 1 WHERE id = 1 RETURNING generation'
			)
			.one();
		for (const tag of tags)
			this.storage.sql.exec(
				`INSERT INTO pending_purge VALUES (?, ?, ?, ?)
				 ON CONFLICT(tag) DO UPDATE SET generation = excluded.generation,
				 urgent = MAX(pending_purge.urgent, excluded.urgent)`,
				tag,
				generation,
				Date.now(),
				urgent ? 1 : 0
			);
		return generation;
	}

	async scheduleRepair(key: string): Promise<void> {
		this.storage.sql.exec('INSERT OR IGNORE INTO repair_schedule VALUES (?, ?)', key, Date.now());
		await this.arm();
	}

	private async runRepairs(): Promise<void> {
		if (!this.resumeRepair) return;
		// Pending pages wake when their tags are actually purged, not by polling D1
		// every pacing interval while a backlog or rate limit delays eviction.
		const jobs = this.storage.sql
			.exec<{ key: string }>(
				`SELECT key FROM repair_schedule s WHERE next_at <= ? AND ${REPAIR_UNBLOCKED}
 ORDER BY next_at, key LIMIT 10`,
				Date.now()
			)
			.toArray();
		for (const { key } of jobs) {
			// Persist a retry before I/O so a canceled invocation cannot strand work.
			this.storage.sql.exec(
				'UPDATE repair_schedule SET next_at = ? WHERE key = ?',
				Date.now() + 60_000,
				key
			);
			await this.arm();
			try {
				const next = await this.resumeRepair(key);
				this.storage.transactionSync(() => {
					if (next === null) {
						this.storage.sql.exec('DELETE FROM repair_tag WHERE key = ?', key);
						this.storage.sql.exec('DELETE FROM repair_receipt WHERE key = ?', key);
						this.storage.sql.exec('DELETE FROM repair_schedule WHERE key = ?', key);
					} else
						this.storage.sql.exec(
							'UPDATE repair_schedule SET next_at = ? WHERE key = ?',
							next,
							key
						);
				});
			} catch (error) {
				console.warn('chunk repair continuation pending', { key, error });
			}
		}
	}

	async alarm(): Promise<void> {
		try {
			await this.flush();
			await this.runRepairs();
		} finally {
			await this.arm();
		}
	}

	private stats(): { depth: number; oldest: number | null } {
		return this.storage.sql
			.exec<{ depth: number; oldest: number | null }>(
				'SELECT COUNT(*) AS depth, MIN(queued_at) AS oldest FROM pending_purge'
			)
			.one();
	}

	private next(): number {
		return this.storage.sql
			.exec<{ next_at: number }>('SELECT next_at FROM purge_clock WHERE id = 1')
			.one().next_at;
	}

	private async arm(): Promise<{ depth: number; oldest: number | null }> {
		const stats = this.stats();
		const { depth, oldest } = stats;
		const repairAt = this.storage.sql
			.exec<{ next: number | null }>(
				`SELECT MIN(next_at) AS next FROM repair_schedule s WHERE ${REPAIR_UNBLOCKED}`
			)
			.one().next;
		if (!depth && repairAt === null) {
			await this.storage.deleteAlarm();
			return stats;
		}
		// Do not reset the batching window on every enqueue (a busy producer must
		// not postpone draining indefinitely).
		await this.storage.setAlarm(
			Math.max(
				Date.now() + 1,
				Math.min(
					depth
						? Math.max(
								(oldest ?? Date.now()) + BATCH_WINDOW_MS,
								this.next(),
								this.flight?.until ?? 0
							)
						: Infinity,
					repairAt ?? Infinity
				)
			)
		);
		return stats;
	}

	private async flush(): Promise<void> {
		if (this.flight && this.flight.until > Date.now()) {
			await this.storage.setAlarm(this.flight.until);
			return;
		}
		if (this.next() > Date.now()) {
			await this.arm();
			return;
		}
		const batch = this.storage.sql
			.exec<Pending>(
				'SELECT tag, generation FROM pending_purge ORDER BY urgent DESC, queued_at, tag LIMIT ?',
				PURGE_TAG_LIMIT
			)
			.toArray();
		if (!batch.length) {
			await this.arm();
			return;
		}
		const flight = { until: Date.now() + 30_000 };
		this.flight = flight;
		let result: PurgeResult = { success: false };
		try {
			this.storage.sql.exec(
				'UPDATE purge_clock SET next_at = ? WHERE id = 1',
				Date.now() + PURGE_INTERVAL_MS
			);
			await this.arm();
			try {
				result = await this.purge(batch.map((row) => row.tag));
			} catch {
				/* RPC transport failure: retain all tags for the armed alarm. */
			}
			this.storage.transactionSync(() => {
				if (this.flight !== flight) return;
				if (result.success) {
					for (const row of batch) {
						this.storage.sql.exec(
							'DELETE FROM repair_tag WHERE tag = ? AND generation <= ?',
							row.tag,
							row.generation
						);
						this.storage.sql.exec(
							'DELETE FROM pending_purge WHERE tag = ? AND generation = ?',
							row.tag,
							row.generation
						);
					}
				} else if (result.rateLimited) {
					this.storage.sql.exec(
						'UPDATE purge_clock SET next_at = ? WHERE id = 1',
						Date.now() + PURGE_COOLDOWN_MS
					);
				}
			});
		} finally {
			if (this.flight === flight) this.flight = undefined;
			const { depth, oldest } = await this.arm();
			console.log(
				JSON.stringify({
					event: 'nimbus.purge.queue',
					depth,
					oldestMs: oldest === null ? 0 : Date.now() - oldest,
					tags: batch.length,
					outcome: result.success ? 'ok' : result.rateLimited ? 'rate-limited' : 'error'
				})
			);
		}
	}
}
