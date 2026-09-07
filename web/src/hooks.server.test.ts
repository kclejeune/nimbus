import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionUser } from '$lib/server/auth/types';

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getDb: vi.fn(),
	primary: vi.fn(),
	replica: vi.fn(),
	readSession: vi.fn(),
	setCookie: vi.fn()
}));
vi.mock('$app/environment', () => ({ building: false }));
vi.mock('better-auth/svelte-kit', () => ({
	svelteKitHandler: ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) =>
		resolve(event)
}));
vi.mock('$lib/server/auth/auth', () => ({
	createAuth: () => ({ api: { getSession: mocks.getSession } })
}));
vi.mock('$lib/server/cache/db', () => ({ readSession: mocks.readSession }));
vi.mock('$lib/server/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('jose', () => ({
	createRemoteJWKSet: () => ({}),
	jwtVerify: async () => ({ payload: { sub: 'alice', email: 'alice@example.test' } })
}));
vi.mock('$lib/server/db', () => ({
	getDb: () => mocks.getDb(),
	schema: { user: { email: 'email', id: 'id', role: 'role' } }
}));
vi.mock('$lib/server/auth/group-sync', () => ({ syncGroupsAndMaybeActivate: vi.fn() }));
import { handle } from './hooks.server';
import { requireAdmin } from '$lib/server/auth/guard';
import { mintSessionToken } from '$lib/server/auth/cf-access';

const binding = { prepare: () => ({ bind: () => ({ first: mocks.primary }) }) };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue(null);
	mocks.getDb.mockImplementation(() => {
		throw new Error('unexpected full Access resolution');
	});
	mocks.primary.mockResolvedValue({ role: 'member', status: 'active' });
	mocks.replica.mockResolvedValue({ role: 'member', status: 'active' });
	mocks.readSession.mockReturnValue({
		prepare: () => ({ bind: () => ({ first: mocks.replica }) })
	});
});
async function request(method = 'POST', admin = false, withCookie = true) {
	const secret = 'test-session-secret';
	const cookie = await mintSessionToken('cfaccess:alice', 'alice', secret);
	const event = {
		request: new Request('https://app.test/settings', {
			method,
			headers: { 'Cf-Access-Jwt-Assertion': 'verified-by-test' }
		}),
		url: new URL('https://app.test/settings'),
		route: { id: '/(app)/settings' },
		locals: {} as { user: SessionUser | null },
		platform: {
			env: {
				ATTIC_DB: binding,
				CF_ACCESS_TEAM_DOMAIN: 'https://team.test',
				CF_ACCESS_AUD: 'aud',
				SESSION_SECRET: secret
			}
		},
		cookies: {
			get: (name: string) => (withCookie && name === 'nimbus-cf-session' ? cookie : undefined),
			set: mocks.setCookie
		}
	};
	const resolve = vi.fn(async () => {
		if (admin) requireAdmin(event.locals);
		return new Response('allowed');
	});
	const result = handle({ event, resolve } as unknown as Parameters<typeof handle>[0]);
	return { result, event, resolve };
}
it('denies admin mutations after demotion despite an unexpired Access admin cookie', async () => {
	const { result, resolve, event } = await request('POST', true);
	await expect(result).rejects.toMatchObject({ status: 403 });
	expect(resolve).toHaveBeenCalledOnce();
	expect(event.locals.user).toMatchObject({ role: 'member', status: 'active' });
	expect(mocks.primary).toHaveBeenCalledOnce();
	expect(mocks.readSession).not.toHaveBeenCalled();
});
it('blocks a deactivated Access user before the mutation handler runs', async () => {
	mocks.primary.mockResolvedValue({ role: 'member', status: 'pending' });
	const { result, resolve } = await request();
	expect((await result).status).toBe(403);
	expect(resolve).not.toHaveBeenCalled();
});
it('rejects a deleted Access user and fails closed on refresh errors', async () => {
	mocks.primary.mockResolvedValue(null);
	const deleted = await request();
	expect((await deleted.result).status).toBe(401);
	expect(deleted.resolve).not.toHaveBeenCalled();
	mocks.primary.mockRejectedValue(new Error('D1 unavailable'));
	const failed = await request();
	await expect(failed.result).rejects.toThrow('D1 unavailable');
	expect(failed.resolve).not.toHaveBeenCalled();
});
it.each(['GET', 'HEAD'])('refreshes Access %s through the read session', async (method) => {
	const { result, event } = await request(method);
	expect((await result).status).toBe(200);
	expect(event.locals.user).toMatchObject({ role: 'member' });
	expect(mocks.replica).toHaveBeenCalledOnce();
	expect(mocks.primary).not.toHaveBeenCalled();
});
it('also refreshes better-auth sessions on the primary for mutations', async () => {
	mocks.getSession.mockResolvedValue({
		user: { id: 'oidc:alice', role: 'admin', status: 'active' }
	});
	const { result, event } = await request();
	expect((await result).status).toBe(200);
	expect(event.locals.user).toMatchObject({ provider: 'oidc', role: 'member' });
	expect(mocks.primary).toHaveBeenCalledOnce();
});

// Minimal drizzle stand-in for upsertAccessUser's happy path: an existing
// active member (select().from().where().limit()) and an admin already
// present (select({ n }).from().where()).
function fakeDb(row: { id: string; email: string; role: string; status: string }) {
	const chain = (result: unknown) => {
		const b: Record<string, unknown> = {};
		for (const m of ['from', 'where', 'limit']) b[m] = () => b;
		b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
		return b;
	};
	return { select: (cols?: unknown) => chain(cols ? [{ n: 1 }] : [row]) };
}
it('trusts the primary row on a first visit instead of re-reading a lagging replica', async () => {
	mocks.getDb.mockReturnValue(
		fakeDb({ id: 'cfaccess:alice', email: 'alice@example.test', role: 'member', status: 'active' })
	);
	mocks.replica.mockResolvedValue(null); // replication has not caught up
	const { result, event } = await request('GET', false, false);
	expect((await result).status).toBe(200);
	expect(event.locals.user).toMatchObject({
		id: 'cfaccess:alice',
		role: 'member',
		status: 'active'
	});
	expect(mocks.replica).not.toHaveBeenCalled();
	expect(mocks.primary).not.toHaveBeenCalled();
	expect(mocks.setCookie).toHaveBeenCalledOnce();
});
