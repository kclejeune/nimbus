import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { testDatabase } from '../cache/test-db';
import { createAuth } from './auth';

vi.mock('$app/server', () => ({ getRequestEvent: () => undefined }));

let fixture: ReturnType<typeof testDatabase>;
let auth: ReturnType<typeof createAuth>;
let nonce: string;
let subject: string;
let groups: string[];
let corruptToken: boolean;
let audience: string;
const keys = await generateKeyPair('RS256');
const app = 'https://app.test';
const issuer = 'https://idp.test';
const tokenRequests: URLSearchParams[] = [];

beforeEach(async () => {
	fixture = testDatabase({ admin: true });
	// An existing owner leaves the new OIDC user subject to normal activation.
	fixture.seedUser('owner', 'active', 'admin');
	fixture.sqlite.exec(
		"INSERT INTO groups (id, name, oidc_group, created_at) VALUES ('dev', 'Developers', 'developers', 0)"
	);
	subject = 'alice';
	groups = ['developers'];
	corruptToken = false;
	tokenRequests.length = 0;
	const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.pathname.endsWith('/.well-known/openid-configuration')) {
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					userinfo_endpoint: `${issuer}/userinfo`,
					jwks_uri: `${issuer}/jwks`,
					id_token_signing_alg_values_supported: ['RS256']
				});
			}
			if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
			if (url.pathname === '/token') {
				tokenRequests.push(new URLSearchParams(String(init?.body)));
				const token = await new SignJWT({
					email: `${subject}@example.test`,
					email_verified: true,
					name: subject,
					groups,
					nonce
				})
					.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
					.setIssuer(corruptToken ? 'https://attacker.test' : issuer)
					.setAudience(audience)
					.setSubject(subject)
					.setIssuedAt()
					.setExpirationTime('5m')
					.sign(keys.privateKey);
				return Response.json({
					access_token: 'access',
					token_type: 'Bearer',
					expires_in: 300,
					id_token: token,
					scope: 'openid email profile groups'
				});
			}
			if (url.pathname === '/userinfo')
				return Response.json({
					sub: subject,
					name: subject,
					email: `${subject}@example.test`,
					email_verified: true
				});
			throw new Error(`Unexpected OAuth request: ${url}`);
		})
	);
	auth = createAuth({
		ATTIC_DB: fixture.db,
		APP_URL: app,
		SESSION_SECRET: 'a-long-test-secret-that-is-at-least-32-characters',
		OIDC_ISSUER: issuer,
		OIDC_CLIENT_ID: 'nimbus',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_GROUPS_CLAIM: 'groups',
		OIDC_ACTIVATION_GROUP: 'developers',
		CF_ACCESS_TEAM_DOMAIN: issuer,
		CF_SSO_CLIENT_ID: 'cloudflare-client',
		CF_SSO_CLIENT_SECRET: 'secret'
	} as App.Platform['env']);
});

afterEach(() => {
	vi.unstubAllGlobals();
	fixture.sqlite.close();
});

const cookies = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');

function mergeCookies(...headers: string[]) {
	const jar = new Map<string, string>();
	for (const header of headers)
		for (const entry of header.split('; ')) {
			const split = entry.indexOf('=');
			if (split > 0) jar.set(entry.slice(0, split), entry.slice(split + 1));
		}
	return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function signIn(provider = 'oidc', sessionCookie = '', link = false) {
	audience = provider === 'cloudflare' ? 'cloudflare-client' : 'nimbus';
	const started = await auth.handler(
		new Request(`${app}/api/auth/${link ? 'link-social' : 'sign-in/social'}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: app, cookie: sessionCookie },
			body: JSON.stringify({
				provider,
				callbackURL: '/account',
				errorCallbackURL: '/login',
				disableRedirect: true
			})
		})
	);
	expect(started.status).toBe(200);
	const authorization = new URL((await started.json()).url);
	const callback = `${app}/api/auth/oauth2/callback/${provider}`;
	expect(authorization.searchParams.get('redirect_uri')).toBe(callback);
	expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
	nonce = authorization.searchParams.get('nonce')!;
	const response = await auth.handler(
		new Request(`${callback}?code=test-code&state=${authorization.searchParams.get('state')}`, {
			headers: { cookie: mergeCookies(sessionCookie, cookies(started)) }
		})
	);
	expect(tokenRequests.at(-1)?.get('redirect_uri')).toBe(callback);
	expect(tokenRequests.at(-1)?.get('code_verifier')).toBeTruthy();
	return response;
}

it('signs in through the existing OIDC callback, syncs groups on every login, and reuses the account', async () => {
	const first = await signIn();
	expect(first.headers.get('location')).toBe('/account');
	expect(cookies(first)).toContain('session_token=');
	expect(fixture.sqlite.prepare('SELECT providerId, accountId FROM account').all()).toMatchObject([
		{ providerId: 'oidc', accountId: 'alice' }
	]);
	expect(
		fixture.sqlite.prepare("SELECT status FROM user WHERE email = 'alice@example.test'").get()
	).toMatchObject({ status: 'active' });
	expect(fixture.sqlite.prepare('SELECT group_id, source FROM group_member').all()).toMatchObject([
		{ group_id: 'dev', source: 'sso' }
	]);
	groups = [];
	const again = await signIn();
	expect(again.headers.get('location')).toBe('/account');
	expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM account').get()).toMatchObject({ n: 1 });
	expect(fixture.sqlite.prepare('SELECT * FROM group_member').all()).toEqual([]);
});

it('rejects an ID token with the wrong issuer before creating a user or session', async () => {
	corruptToken = true;
	const response = await signIn();
	expect(response.headers.get('location')).toContain('error=');
	expect(fixture.sqlite.prepare('SELECT * FROM account').all()).toEqual([]);
	expect(fixture.sqlite.prepare('SELECT * FROM session').all()).toEqual([]);
});

it('keeps Cloudflare SSO link-only and unlinks by the local account row ID', async () => {
	const denied = await signIn('cloudflare');
	expect(denied.headers.get('location')).toContain('error=signup_disabled');
	expect(fixture.sqlite.prepare('SELECT * FROM account').all()).toEqual([]);
	const session = cookies(await signIn());
	subject = 'cloudflare-alice';
	const linked = await signIn('cloudflare', session, true);
	expect(linked.headers.get('location')).toBe('/account');
	const row = fixture.sqlite
		.prepare("SELECT id FROM account WHERE providerId = 'cloudflare'")
		.get()!;
	const unlinked = await auth.handler(
		new Request(`${app}/api/auth/unlink-account`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: app, cookie: session },
			body: JSON.stringify({ accountId: row.id })
		})
	);
	expect(unlinked.status).toBe(200);
	expect(fixture.sqlite.prepare('SELECT providerId FROM account').all()).toMatchObject([
		{ providerId: 'oidc' }
	]);
});
