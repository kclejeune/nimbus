#!/usr/bin/env node
// Brings the D1 database up to date, fresh or existing. Runs as `npm run
// migrate` (chained into deploy); `--local [--persist-to DIR]` targets the
// wrangler dev database instead of the remote one.
//
// Two schema sources share the database:
//
// - Cache tables: schema/schema.sql is the current schema; schema/migrations/
//   holds deltas for databases created before each change, tracked by
//   wrangler in d1_migrations. The deltas do not replay from empty (the first
//   ALTERs a table only schema.sql creates), so an empty database loads
//   schema.sql and records every existing delta as applied. schema.test.ts
//   keeps schema.sql and the deltas in agreement.
// - Admin tables: drizzle-kit output in drizzle/, tracked here in
//   admin_migrations. Databases that predate the tracking table applied these
//   files by hand; each file whose tables, indexes, and columns all exist is
//   recorded as applied, and the rest run.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const local = args.includes('--local');
const persistIdx = args.indexOf('--persist-to');
const target = [
	local ? '--local' : '--remote',
	...(persistIdx >= 0 ? ['--persist-to', args[persistIdx + 1]] : []),
	...(existsSync(join(webDir, 'wrangler.local.jsonc')) ? ['--config=wrangler.local.jsonc'] : [])
];
const DB = 'ATTIC_DB';

function wrangler(argv, { json = false } = {}) {
	const res = spawnSync(join(webDir, 'node_modules/.bin/wrangler'), [...argv, ...target], {
		cwd: webDir,
		encoding: 'utf8',
		stdio: json ? ['ignore', 'pipe', 'inherit'] : 'inherit'
	});
	if (res.status !== 0) {
		if (json && res.stdout) console.error(res.stdout.trim());
		console.error(`migrate: wrangler ${argv.slice(0, 3).join(' ')} failed`);
		process.exit(res.status ?? 1);
	}
	return json ? JSON.parse(res.stdout) : null;
}

function query(sql) {
	return wrangler(['d1', 'execute', DB, '--json', `--command=${sql}`], { json: true })[0].results;
}

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-migrate-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
function executeSql(sql) {
	const file = join(scratch, 'batch.sql');
	writeFileSync(file, sql);
	wrangler(['d1', 'execute', DB, '--yes', `--file=${file}`]);
}

const sqlString = (s) => `'${s.replaceAll("'", "''")}'`;
const sqlFiles = (dir) =>
	readdirSync(join(webDir, dir))
		.filter((f) => f.endsWith('.sql'))
		.sort();

const master = query("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index')");
const tables = new Set(master.filter((r) => r.type === 'table').map((r) => r.name));

// Cache tables.
const deltas = sqlFiles('schema/migrations');
if (!tables.has('cache')) {
	console.log('migrate: empty database, loading schema/schema.sql');
	executeSql(
		[
			readFileSync(join(webDir, 'schema/schema.sql'), 'utf8'),
			// wrangler's own d1_migrations definition.
			'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
			...deltas.map((f) => `INSERT OR IGNORE INTO d1_migrations (name) VALUES (${sqlString(f)});`)
		].join('\n')
	);
} else if (!tables.has('d1_migrations')) {
	console.error(
		'migrate: the database has cache tables but no d1_migrations table, so which\n' +
			'schema/migrations/ files it already has is unknown. Insert the name of each\n' +
			'applied file into d1_migrations (wrangler creates the table on first use), then rerun.'
	);
	process.exit(1);
}

// Admin tables: one write covering the tracking table, any hand-applied
// files it has not recorded yet, and every pending file.
const adminFiles = sqlFiles('drizzle');
const recordSql = (file) =>
	`INSERT OR IGNORE INTO admin_migrations (name, applied_at) VALUES (${sqlString(file)}, datetime('now'));`;
const adminSql = [];
let applied;
if (tables.has('admin_migrations')) {
	applied = new Set(query('SELECT name FROM admin_migrations').map((r) => r.name));
} else {
	applied = new Set();
	if (tables.has('user')) {
		const objects = new Set(master.map((r) => r.name));
		// D1 refuses pragma_table_info in queries; ALTER TABLE ADD rewrites the
		// table's stored CREATE statement, so the column shows up there instead.
		const tableSql = new Map(master.map((r) => [r.name, r.sql ?? '']));
		const hasColumn = (t, c) => new RegExp(`[\\s(,\`"]${c}[\`"\\s]`).test(tableSql.get(t) ?? '');
		for (const file of adminFiles) {
			const sql = readFileSync(join(webDir, 'drizzle', file), 'utf8');
			const created = [...sql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) `([^`]+)`/g)];
			const added = [...sql.matchAll(/ALTER TABLE `([^`]+)` ADD `([^`]+)`/g)];
			const present =
				created.every(([, name]) => objects.has(name)) &&
				added.every(([, t, c]) => hasColumn(t, c));
			if (!present) break;
			applied.add(file);
		}
		console.log(`migrate: recording ${applied.size} hand-applied drizzle migration(s)`);
	}
	adminSql.push(
		'CREATE TABLE IF NOT EXISTS admin_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
		...[...applied].map(recordSql)
	);
}
for (const file of adminFiles.filter((f) => !applied.has(f))) {
	console.log(`migrate: applying drizzle/${file}`);
	adminSql.push(
		readFileSync(join(webDir, 'drizzle', file), 'utf8').replaceAll('--> statement-breakpoint', ''),
		recordSql(file)
	);
}
if (adminSql.length > 0) executeSql(adminSql.join('\n'));

// Cache-table deltas since the database was created.
wrangler(['d1', 'migrations', 'apply', DB]);
