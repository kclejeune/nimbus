import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';

/** Real SQLite SQL semantics, not a simulation of D1 replication or workerd. */
export function testDatabase() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../../../../schema/schema.sql', import.meta.url), 'utf8'));
	const totalChanges = () => Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n);
	const prepare = (sql: string) => {
		let params: Record<string, SQLInputValue> = {};
		const stmt = {
			bind(...values: SQLInputValue[]) {
				params = Object.fromEntries(values.map((v, i) => [String(i + 1), v]));
				return stmt;
			},
			execute() {
				const before = totalChanges();
				const results = sqlite.prepare(sql).all(params);
				return {
					results,
					success: true,
					meta: {
						changes: totalChanges() - before,
						last_row_id: Number(sqlite.prepare('SELECT last_insert_rowid() AS id').get()!.id)
					}
				};
			},
			async all() {
				return stmt.execute();
			},
			async first() {
				return (await stmt.all()).results[0] ?? null;
			},
			async run() {
				return stmt.all();
			}
		};
		return stmt;
	};
	const binding = {
		prepare,
		withSession() {
			return binding;
		},
		async batch(stmts: ReturnType<typeof prepare>[]) {
			sqlite.exec('BEGIN');
			try {
				const results = [];
				for (const stmt of stmts) results.push(stmt.execute());
				sqlite.exec('COMMIT');
				return results;
			} catch (e) {
				sqlite.exec('ROLLBACK');
				throw e;
			}
		}
	};
	return { sqlite, db: binding as unknown as D1Database, totalChanges };
}
