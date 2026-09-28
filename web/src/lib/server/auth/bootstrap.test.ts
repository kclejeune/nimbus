import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '$lib/server/cache/test-db';
import { claimBootstrapAdmin } from './bootstrap';

describe('claimBootstrapAdmin', () => {
	const fixture = testDatabase({ admin: true });
	const row = (id: string) =>
		fixture.sqlite.prepare('SELECT role, status, is_owner FROM user WHERE id = ?').get(id);
	afterEach(() => fixture.sqlite.exec('DELETE FROM user'));

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

	it('recovers a deployment whose existing users are all pending members', async () => {
		fixture.seedUser('stuck', 'pending');
		fixture.seedUser('other', 'pending');
		expect(await claimBootstrapAdmin(fixture.db, 'other')).toEqual({
			role: 'admin',
			status: 'active'
		});
		expect(row('other')).toMatchObject({ role: 'admin', status: 'active' });
		expect(row('stuck')).toMatchObject({ role: 'member', status: 'pending' });
	});

	it('never promotes once an admin exists', async () => {
		fixture.seedUser('admin', 'active', 'admin');
		fixture.seedUser('late', 'pending');
		expect(await claimBootstrapAdmin(fixture.db, 'late')).toBeNull();
		expect(row('late')).toEqual({ role: 'member', status: 'pending', is_owner: 0 });
	});
});
