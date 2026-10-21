import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../../../../drizzle/', import.meta.url);
const sql = (name: string) =>
	readFileSync(new URL(name, migrations), 'utf8').replaceAll('--> statement-breakpoint', '');

function database(existingUser: boolean): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec(sql('0000_init_admin.sql'));
	if (existingUser) {
		db.prepare(
			`INSERT INTO user
			 (id, name, email, emailVerified, role, createdAt, updatedAt)
			 VALUES (?, ?, ?, 1, 'admin', ?, ?)`
		).run('owner', 'Owner', 'owner@example.test', 1, 1);
	}
	db.exec(sql('0007_lock-admin-bootstrap.sql'));
	return db;
}

describe('admin bootstrap migration', () => {
	it('marks an existing installation as already bootstrapped', () => {
		const db = database(true);
		expect(db.prepare('SELECT id, completed_at FROM bootstrap_state').get()).toMatchObject({
			id: 1,
			completed_at: expect.any(Number)
		});
		db.close();
	});

	it('leaves a fresh installation open for its first sign-in', () => {
		const db = database(false);
		expect(db.prepare('SELECT COUNT(*) AS n FROM bootstrap_state').get()).toEqual({ n: 0 });
		db.close();
	});
});
