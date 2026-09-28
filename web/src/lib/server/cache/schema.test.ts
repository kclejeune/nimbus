import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testDatabase } from './test-db';

// Fresh installs load schema.sql and mark every migration applied
// (scripts/migrate.mjs), so schema.sql must already contain everything the
// migrations produce. Replaying the migrations over schema.sql must therefore
// change nothing; an ALTER re-adding an existing column is the only expected
// failure.

const migrationsDir = new URL('../../../../schema/migrations/', import.meta.url);

/** Per-statement split so one duplicate-column ALTER doesn't abort a file.
 * Naive on purpose: the deltas have no triggers or `;` inside literals. */
function statements(sql: string): string[] {
	return sql
		.split(/;\s*\n/)
		.map((s) =>
			s
				.split('\n')
				.filter((line) => !line.trim().startsWith('--'))
				.join('\n')
				.trim()
		)
		.filter(Boolean);
}

function shape(db: DatabaseSync) {
	const objects = db
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
		)
		.all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
	return objects.map((o) =>
		o.type === 'table'
			? {
					type: o.type,
					name: o.name,
					columns: db
						.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
						.all(o.name)
						.sort((a, b) => String(a.name).localeCompare(String(b.name))),
					foreignKeys: db
						.prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY "from"`)
						.all(o.name)
				}
			: {
					type: o.type,
					name: o.name,
					table: o.tbl_name,
					sql: o.sql
						?.replace(/\s+/g, ' ')
						.replace(/ IF NOT EXISTS/i, '')
						.trim()
				}
	);
}

describe('schema.sql', () => {
	it('already contains every migration', () => {
		const { sqlite: db } = testDatabase();
		const before = shape(db);

		const migrations = readdirSync(migrationsDir)
			.filter((f) => f.endsWith('.sql'))
			.sort();
		for (const file of migrations) {
			for (const stmt of statements(readFileSync(new URL(file, migrationsDir), 'utf8'))) {
				try {
					db.exec(stmt);
				} catch (e) {
					if (!/duplicate column name/.test(String(e))) {
						throw new Error(`${file}: ${e}\n${stmt}`);
					}
				}
			}
		}

		expect(shape(db)).toEqual(before);
	});
});
