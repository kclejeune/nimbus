import { afterEach, describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { load as browserLoad, actions as browserActions } from '../../routes/cli/+page.server';
import { load as deviceLoad, actions as deviceActions } from '../../routes/cli/device/+page.server';
import { testDatabase } from './cache/test-db';
import { verifyAtticToken } from './attic/token';

const SECRET = btoa('0123456789abcdef0123456789abcdef');
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.sqlite.close();
});

function fixture(role: 'admin' | 'member') {
	const f = testDatabase({ admin: true });
	fixtures.push(f);
	f.seedUser('u', 'active', role);
	f.sqlite
		.exec(`INSERT INTO permission_grant (id, subject_type, subject_id, pattern, actions, created_at)
		VALUES ('g', 'user', 'u', '*', '{"r":1,"w":1}', 0);
		INSERT INTO device_auth (device_code, user_code, status, created_at, expires_at)
		VALUES ('device', 'ABCD-EFGH', 'pending', 0, ${Math.floor(Date.now() / 1000) + 600});`);
	const locals: App.Locals = {
		user: {
			id: 'u',
			sub: 'u',
			provider: 'oidc',
			email: 'u@example.test',
			name: 'u',
			role,
			status: 'active'
		}
	};
	return {
		...f,
		event: {
			url: new URL('https://app.test/cli?port=12345&state=nonce&code=ABCD-EFGH'),
			locals,
			platform: { env: { ATTIC_DB: f.db, JWT_HS256_SECRET_BASE64: SECRET } }
		}
	};
}

for (const flow of [
	{ name: 'browser', load: browserLoad, action: browserActions.authorize },
	{ name: 'device', load: deviceLoad, action: deviceActions.approve }
]) {
	describe(`${flow.name} CLI authorization`, () => {
		it.each(['admin', 'member'] as const)(
			'exposes the signed-in %s role to the scope picker',
			async (role) => {
				const f = fixture(role);
				const data = await flow.load(f.event as never);
				expect(data?.user.role).toBe(role);
				expect(data?.scopeOptions[0]).toMatchObject({ value: '*', bits: { r: 1, w: 1 } });
			}
		);

		it.each([false, true])(
			'mints only the admin scopes explicitly selected (selected=%s)',
			async (selected) => {
				const f = fixture('admin');
				const form = new FormData();
				for (const [key, value] of Object.entries({
					port: '12345',
					state: 'nonce',
					user_code: 'ABCD-EFGH',
					cache: '*',
					pull: 'on',
					push: 'on'
				})) {
					form.set(key, value);
				}
				if (selected) {
					for (const field of ['delete', 'configure_cache', 'destroy_cache', 'gc', 'ct'])
						form.set(field, 'on');
				}
				let token: string | null = null;
				try {
					const result = await flow.action({
						...f.event,
						request: new Request('https://app.test/cli', { method: 'POST', body: form })
					} as never);
					expect(flow.name).toBe('device');
					expect(result).toEqual({ approved: true });
					token = f.sqlite.prepare('SELECT token FROM device_auth').get()!.token as string;
				} catch (e) {
					if (!isRedirect(e)) throw e;
					expect(flow.name).toBe('browser');
					expect(e.status).toBe(303);
					const callback = new URL(e.location);
					expect(callback.origin).toBe('http://127.0.0.1:12345');
					expect(callback.searchParams.get('state')).toBe('nonce');
					token = callback.searchParams.get('token');
				}
				expect(token).toBeTruthy();
				const verified = await verifyAtticToken(token!, { hs256SecretBase64: SECRET });
				expect(verified.gc).toBe(selected);
				expect(verified.ct).toBe(selected);
				expect(verified.caches.get('*')).toMatchObject({
					pull: true,
					push: true,
					delete: selected,
					configureCache: selected,
					destroyCache: selected
				});
				expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM api_token').get()!.n).toBe(1);
			}
		);

		it.each(['gc', 'ct', 'delete', 'configure_cache', 'destroy_cache'])(
			'rejects a member forging %s',
			async (field) => {
				const f = fixture('member');
				const form = new FormData();
				for (const [key, value] of Object.entries({
					port: '12345',
					state: 'nonce',
					user_code: 'ABCD-EFGH',
					cache: '*',
					pull: 'on',
					push: 'on',
					[field]: 'on'
				}))
					form.set(key, value);
				const result = await flow.action({
					...f.event,
					request: new Request('https://app.test/cli', { method: 'POST', body: form })
				} as never);
				expect(result).toMatchObject({ status: 403 });
				expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM api_token').get()!.n).toBe(0);
				expect(f.sqlite.prepare('SELECT status FROM device_auth').get()!.status).toBe('pending');
			}
		);
	});
}
