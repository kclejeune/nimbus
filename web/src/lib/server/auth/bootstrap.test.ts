import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '$lib/server/cache/test-db';
import { claimBootstrapAdmin } from './bootstrap';

describe('claimBootstrapAdmin', () => {
	const fixture = testDatabase({ admin: true });
	const row = (id: string) =>
		fixture.sqlite.prepare('SELECT role, status, is_owner FROM user WHERE id = ?').get(id);
	afterEach(() => fixture.sqlite.exec('DELETE FROM user; DELETE FROM bootstrap_state'));

	it('promotes the first user to active admin and owner', async () => {
		fixture.seedUser('first', 'pending');
		expect(await claimBootstrapAdmin(fixture.db, 'first')).toEqual({
			role: 'admin',
			status: 'active'
		});
		expect(row('first')).toEqual({ role: 'admin', status: 'active', is_owner: 1 });
	});

	it('promotes exactly one user while no admin exists', async () => {
		fixture.seedUser('a', 'pending');
		fixture.seedUser('b', 'pending');
		expect(await claimBootstrapAdmin(fixture.db, 'a')).toEqual({ role: 'admin', status: 'active' });
		expect(await claimBootstrapAdmin(fixture.db, 'b')).toBeNull();
		expect(row('b')).toEqual({ role: 'member', status: 'pending', is_owner: 0 });
	});

	it('does not reopen bootstrap after administrators are removed', async () => {
		fixture.seedUser('stuck', 'pending');
		fixture.seedUser('other', 'pending');
		fixture.sqlite.exec('INSERT INTO bootstrap_state (id, completed_at) VALUES (1, unixepoch())');
		expect(await claimBootstrapAdmin(fixture.db, 'other')).toBeNull();
		expect(row('other')).toMatchObject({ role: 'member', status: 'pending' });
		expect(row('stuck')).toMatchObject({ role: 'member', status: 'pending' });
	});

	it('can be reopened only by explicitly clearing the durable latch', async () => {
		fixture.seedUser('recovery', 'pending');
		fixture.sqlite.exec('INSERT INTO bootstrap_state (id, completed_at) VALUES (1, unixepoch())');
		expect(await claimBootstrapAdmin(fixture.db, 'recovery')).toBeNull();
		fixture.sqlite.exec('DELETE FROM bootstrap_state');
		expect(await claimBootstrapAdmin(fixture.db, 'recovery')).toEqual({
			role: 'admin',
			status: 'active'
		});
	});

	it('never promotes once an admin exists', async () => {
		fixture.seedUser('admin', 'active', 'admin');
		fixture.seedUser('late', 'pending');
		expect(await claimBootstrapAdmin(fixture.db, 'late')).toBeNull();
		expect(row('late')).toEqual({ role: 'member', status: 'pending', is_owner: 0 });
	});
});
