import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { D1Database } from '@cloudflare/workers-types';
import { testDatabase } from './test-db';
import type { ExecutionContext } from './platform';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

const SECRET = new TextEncoder().encode('discovery-hedge-secret');
let router: typeof import('./router');
let fixture: ReturnType<typeof testDatabase>;
beforeEach(async () => {
	// Fresh hedge lease and revocation/cache-row memos per case.
	vi.resetModules();
	router = await import('./router');
	fixture = testDatabase({ admin: true });
	fixture.sqlite.exec(
		"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'private','',0,'zstd',datetime('now'))"
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	fixture.sqlite.close();
});

/** A replica that never answers the revocation lookup; every other read passes through. */
function stalledRevocationReplica() {
	const never = () => new Promise<never>(() => {});
	const stalled = { first: never, all: never, raw: never, run: never };
	const replica = {
		...fixture.db,
		prepare: (sql: string) =>
			sql.includes('revoked_token') ? { bind: () => stalled, ...stalled } : fixture.db.prepare(sql),
		batch: fixture.db.batch.bind(fixture.db)
	} as unknown as D1Database;
	return vi
		.spyOn(fixture.db, 'withSession')
		.mockImplementation(
			(constraint) => (constraint === 'first-primary' ? fixture.db : replica) as never
		);
}

it.each(['/private/nix-cache-info', '/private/attic-cache-info', '/_api/v1/cache-config/private'])(
	'%s falls back to the primary when the revocation replica stalls',
	async (path) => {
		const sessions = stalledRevocationReplica();
		const token = await new SignJWT({
			'https://jwt.attic.rs/v1': { caches: { private: { r: 1 } } }
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setJti('discovery-hedge')
			.setExpirationTime('1h')
			.sign(SECRET);
		const env = {
			ATTIC_DB: fixture.db,
			JWT_HS256_SECRET_BASE64: Buffer.from(SECRET).toString('base64'),
			CACHE_BASE_URL: 'https://cache.test'
		} as unknown as App.Platform['env'];
		const tasks: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (work: Promise<unknown>) => void tasks.push(work)
		} as ExecutionContext;

		// Real timers: token verification is off-thread WebCrypto, so fake time
		// would advance before the hedge's 500 ms timer exists.
		const response = await router.handleCacheApi(
			new Request(`https://cache.test${path}`, { headers: { Authorization: `Bearer ${token}` } }),
			env,
			ctx
		);
		expect(response.status).toBe(200);
		expect(sessions).toHaveBeenCalledWith('first-primary');
	}
);
