import { afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from '$lib/server/cache/test-db';
import { load, actions } from './+page.server';
vi.mock('$lib/server/cache/compression', async () =>
	(await import('$lib/server/cache/test-db')).fakeCompression()
);
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});
function fixture() {
	const f = testDatabase({ admin: true });
	fixtures.push(f);
	f.sqlite.exec(
		"INSERT INTO cache(id,name,keypair,created_at) VALUES(1,'one','k','2026-01-01'),(2,'two','k','2026-01-01')"
	);
	const event = {
		locals: { user: { id: 'admin', role: 'admin', status: 'active' } },
		platform: {
			env: { ATTIC_DB: f.db, SESSION_SECRET: 'test-secret-at-least-32-characters' },
			ctx: { waitUntil: vi.fn() }
		}
	} as unknown as Parameters<typeof load>[0];
	return { ...f, event };
}
it('fresh Settings loads use small status rows instead of orphan or graph counts', async () => {
	const f = fixture();
	const prepare = vi.spyOn(f.db, 'prepare');
	const data = await load(f.event);
	expect(data).toMatchObject({
		closureCaches: [{ name: 'one' }, { name: 'two' }],
		dataUnavailable: false
	});
	expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
		/COUNT\(|JOIN object|FROM nar|FROM chunk/
	);
});
it('keeps Settings loadable under display-query overload and disables editing an unknown limit', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const f = fixture();
	const original = f.db.prepare.bind(f.db);
	vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
		const stmt = original(sql);
		stmt.all = vi.fn().mockRejectedValue(new Error('D1_ERROR: database is overloaded'));
		return stmt;
	});
	expect(await load(f.event)).toMatchObject({
		dataUnavailable: true,
		limitUnavailable: true,
		closureCaches: [],
		gcOperation: null
	});
});
it('guards all-cache checks and redirects non-JS submissions to a refresh-safe GET', async () => {
	const f = fixture();
	const body = new FormData();
	body.set('cache', '*');
	const event = {
		...f.event,
		request: new Request('https://app.test/settings?/startClosureCheck', { method: 'POST', body })
	} as Parameters<NonNullable<typeof actions.startClosureCheck>>[0];
	await expect(actions.startClosureCheck!(event)).rejects.toMatchObject({
		status: 303,
		location: '/settings'
	});
	expect(await load(f.event)).toMatchObject({
		closureCheck: { scope: '*', caches: [{ name: 'one' }, { name: 'two' }] }
	});
	event.locals.user!.role = 'member';
	await expect(actions.startClosureCheck!(event)).rejects.toMatchObject({ status: 403 });
});
it('JSON checks return persistent progress and invalid cache names are rejected', async () => {
	const f = fixture();
	const body = new FormData();
	body.set('cache', '*');
	const event = {
		...f.event,
		request: new Request('https://app.test/settings?/startClosureCheck', {
			method: 'POST',
			body,
			headers: { accept: 'application/json' }
		})
	} as Parameters<NonNullable<typeof actions.startClosureCheck>>[0];
	expect(await actions.startClosureCheck!(event)).toMatchObject({
		closureCheck: { scope: '*', state: 'running' }
	});
	const bad = new FormData();
	bad.set('cache', '../bad');
	const badEvent = {
		...event,
		request: new Request('https://app.test/settings', { method: 'POST', body: bad })
	};
	expect(await actions.startClosureCheck!(badEvent)).toMatchObject({ status: 400 });
});
