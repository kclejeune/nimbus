import { DatabaseSync } from 'node:sqlite';
import { expect, vi } from 'vitest';
import { PurgeQueue, type PurgeResult } from './purge-queue';
export function testPurgeQueue(
	purge = vi.fn(async (_tags: string[]): Promise<PurgeResult> => ({ success: true })),
	resumeRepair?: (key: string) => Promise<number | null>
) {
	const db = new DatabaseSync(':memory:');
	let alarm: number | null = null;
	const storage = {
		sql: {
			exec(sql: string, ...bindings: (string | number)[]) {
				const rows = db.prepare(sql).all(...bindings);
				return {
					toArray: () => rows,
					one: () => {
						expect(rows).toHaveLength(1);
						return rows[0];
					}
				};
			}
		},
		transactionSync<T>(fn: () => T): T {
			db.exec('BEGIN');
			try {
				const result = fn();
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		async setAlarm(t: number) {
			alarm = t;
		},
		async deleteAlarm() {
			alarm = null;
		}
	} as unknown as ConstructorParameters<typeof PurgeQueue>[0];
	const queue = new PurgeQueue(storage, purge, resumeRepair);
	const depth = () => Number(db.prepare('SELECT COUNT(*) AS n FROM pending_purge').get()!.n);
	return { queue, purge, storage, depth, sqlite: db, alarm: () => alarm };
}
