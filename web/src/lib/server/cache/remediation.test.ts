// Regressions for docs/security-remediation-plan-2026-09-27.md.

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimit } from '@cloudflare/workers-types';
import { memoryBucket, testDatabase } from './test-db';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

import { handleCacheApi } from './router';
import { invalidateCacheRow } from './cache-lookup';
import { clearUpstreamsMemo } from './missing-paths';
import { clearCandidateMemos } from './metadata';
import { configureCache, createCache, destroyCache, renameCache } from './cache-config';
import { isTokenDisabled, pruneRevokedTokens } from './db';
import { claimManualGcSlot, MANUAL_GC_COOLDOWN_MS } from './gc';
import { enforceLimit } from './admission';
import { deleteUser } from '../auth/user-admin';
import { NIMBUS_CLAIM_NAMESPACE } from '../attic-token';

type Env = App.Platform['env'];

const fixture = testDatabase({ admin: true });
const key = new TextEncoder().encode('remediation-test-secret');
const baseEnv = {
	ATTIC_DB: fixture.db,
	CACHE_BUCKET: memoryBucket().bucket,
	JWT_HS256_SECRET_BASE64: Buffer.from(key).toString('base64'),
	CACHE_BASE_URL: 'https://cache.test'
} as unknown as Env;

type Bits = Record<string, number>;
let jtiCounter = 0;
/** The router's token memos are module-level; never share a jti across tests. */
const freshJti = (label: string) => `${label}-${++jtiCounter}-${Math.random()}`;

async function mint(
	caches: Record<string, Bits>,
	opts: { jti?: string; gc?: boolean; sub?: string } = {}
): Promise<string> {
	let builder = new SignJWT({
		'https://jwt.attic.rs/v1': { caches },
		...(opts.gc ? { [NIMBUS_CLAIM_NAMESPACE]: { gc: 1 } } : {})
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setExpirationTime('1h');
	if (opts.jti) builder = builder.setJti(opts.jti);
	if (opts.sub) builder = builder.setSubject(opts.sub);
	return builder.sign(key);
}

function call(
	path: string,
	init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
	env: Env = baseEnv
): Promise<Response> {
	const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.9', ...init.headers };
	if (init.token) headers.Authorization = `Bearer ${init.token}`;
	return handleCacheApi(
		new Request(`https://cache.test${path}`, {
			method: init.method ?? 'GET',
			headers,
			body:
				init.body === undefined
					? undefined
					: typeof init.body === 'string'
						? init.body
						: JSON.stringify(init.body)
		}),
		env
	);
}

const now = () => Math.floor(Date.now() / 1000);

function seedUser(id: string, status = 'active', role = 'member') {
	fixture.sqlite
		.prepare(
			`INSERT INTO user (id, name, email, emailVerified, role, is_owner, status, createdAt, updatedAt)
			 VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)`
		)
		.run(id, id, `${id}@example.test`, role, status, now(), now());
}

function seedToken(jti: string, userId: string, expiresAt: number | null = now() + 3600) {
	fixture.sqlite
		.prepare(
			`INSERT INTO api_token (id, user_id, name, token_hash, permissions, expires_at, created_at)
			 VALUES (?, ?, 'test', 'hash', '{}', ?, ?)`
		)
		.run(jti, userId, expiresAt, now());
}

const count = (sql: string) => Number(fixture.sqlite.prepare(sql).get()!.n);

beforeEach(() => {
	invalidateCacheRow();
	clearUpstreamsMemo();
	clearCandidateMemos();
	fixture.sqlite.exec('PRAGMA foreign_keys = OFF');
	fixture.sqlite.exec(`
		DELETE FROM gc_root; DELETE FROM pin; DELETE FROM object; DELETE FROM nar;
		DELETE FROM cache_upstream; DELETE FROM cache; DELETE FROM server_config;
		DELETE FROM revoked_token; DELETE FROM api_token; DELETE FROM audit_log;
		DELETE FROM permission_grant; DELETE FROM session; DELETE FROM account; DELETE FROM user;
	`);
	fixture.sqlite
		.exec(`INSERT INTO cache (id, name, keypair, is_public, compression, created_at) VALUES
		(1, 'victim', '', 0, 'zstd', datetime('now')),
		(2, 'pub', '', 1, 'zstd', datetime('now'))`);
});
afterEach(() => {
	vi.useRealTimers();
});

describe('P0: user deletion preserves token revocation', () => {
	it('rejects a deleted user’s token on private read, upload, configure, and GC', async () => {
		seedUser('alice');
		const jti = freshJti('deleted');
		seedToken(jti, 'alice');
		const token = await mint({ victim: { r: 1, w: 1, cr: 1 } }, { jti, gc: true });

		await deleteUser(fixture.db, 'alice', null);
		expect(count('SELECT count(*) AS n FROM api_token')).toBe(0);
		expect(count('SELECT count(*) AS n FROM revoked_token')).toBe(1);

		expect((await call('/victim/nix-cache-info', { token })).status).toBe(401);
		const push = await call('/_api/v1/get-missing-paths', {
			method: 'POST',
			token,
			body: { cache: 'victim', store_path_hashes: ['a'.repeat(32)] }
		});
		expect(push.status).toBe(401);
		const patch = await call('/_api/v1/cache-config/victim', {
			method: 'PATCH',
			token,
			body: { priority: 10 }
		});
		expect(patch.status).toBe(401);
		expect((await call('/_api/v1/gc?dry_run=1', { method: 'POST', token })).status).toBe(401);
		expect(count("SELECT count(*) AS n FROM server_config WHERE key LIKE 'gc_%'")).toBe(0);
	});

	it('keeps a deactivated user’s token disabled through deletion', async () => {
		seedUser('bob', 'pending');
		const jti = freshJti('deactivated');
		seedToken(jti, 'bob');
		expect(await isTokenDisabled(fixture.db, jti)).toBe(true);
		await deleteUser(fixture.db, 'bob', null);
		expect(await isTokenDisabled(fixture.db, jti)).toBe(true);
	});

	it('still accepts an untracked attic/bootstrap token with a jti', async () => {
		const jti = freshJti('untracked');
		expect(await isTokenDisabled(fixture.db, jti)).toBe(false);
		const token = await mint({ victim: { r: 1 } }, { jti });
		expect((await call('/victim/nix-cache-info', { token })).status).toBe(200);
	});

	it('prunes expired tombstones and keeps unexpired and timeless ones', async () => {
		seedUser('carol');
		seedToken('expired', 'carol', now() - 86_400);
		seedToken('live', 'carol', now() + 86_400);
		seedToken('timeless', 'carol', null);
		await deleteUser(fixture.db, 'carol', null);
		expect(await pruneRevokedTokens(fixture.db)).toBe(1);
		const left = fixture.sqlite
			.prepare('SELECT jti FROM revoked_token ORDER BY jti')
			.all()
			.map((r) => r.jti);
		expect(left).toEqual(['live', 'timeless']);
		expect(await isTokenDisabled(fixture.db, 'timeless')).toBe(true);
	});

	it('deletes a user with audit history under FK enforcement, keeping the trail', async () => {
		seedUser('admin', 'active', 'admin');
		seedUser('dave');
		seedToken('dave-token', 'dave');
		fixture.sqlite
			.prepare(
				"INSERT INTO audit_log (id, user_id, action, created_at) VALUES ('a1', 'dave', 'token.issue', ?)"
			)
			.run(now());
		fixture.sqlite.exec('PRAGMA foreign_keys = ON');
		await deleteUser(fixture.db, 'dave', 'admin');
		expect(count("SELECT count(*) AS n FROM user WHERE id = 'dave'")).toBe(0);
		expect(fixture.sqlite.prepare("SELECT user_id FROM audit_log WHERE id = 'a1'").get()).toEqual({
			user_id: null
		});
		const entry = fixture.sqlite
			.prepare("SELECT user_id, target, detail FROM audit_log WHERE action = 'user.delete'")
			.get()!;
		expect(entry).toMatchObject({ user_id: 'admin', target: 'dave' });
		expect(JSON.parse(String(entry.detail))).toEqual({
			email: 'dave@example.test',
			name: 'dave'
		});
		expect(await isTokenDisabled(fixture.db, 'dave-token')).toBe(true);
	});

	it('leaves tokens intact and writes no tombstone when the batch fails', async () => {
		seedUser('dave');
		seedToken('dave-token', 'dave');
		// Fail the final DELETE; the whole batch must roll back.
		fixture.sqlite.exec(
			"CREATE TEMP TRIGGER fail_user_delete BEFORE DELETE ON user WHEN old.id = 'dave' BEGIN SELECT RAISE(ABORT, 'forced failure'); END"
		);
		try {
			await expect(deleteUser(fixture.db, 'dave', null)).rejects.toThrow();
		} finally {
			fixture.sqlite.exec('DROP TRIGGER fail_user_delete');
		}
		expect(count('SELECT count(*) AS n FROM api_token')).toBe(1);
		expect(count('SELECT count(*) AS n FROM revoked_token')).toBe(0);
		expect(count('SELECT count(*) AS n FROM audit_log')).toBe(0);
		expect(count("SELECT count(*) AS n FROM user WHERE id = 'dave'")).toBe(1);
	});
});

describe('P0: cache rename requires configure on the source', () => {
	const rename = (token: string, from = 'victim', to = 'renamed') =>
		call(`/_api/v1/cache-config/${from}/rename`, {
			method: 'POST',
			token,
			body: { new_name: to }
		});
	const cacheNames = () =>
		fixture.sqlite
			.prepare('SELECT name FROM cache ORDER BY name')
			.all()
			.map((r) => r.name);

	it('refuses a create-only (cc:*) token and changes nothing', async () => {
		fixture.sqlite
			.prepare(
				"INSERT INTO permission_grant (id, subject_type, subject_id, pattern, actions, created_at) VALUES ('g1', 'user', 'u', 'victim', '{}', ?)"
			)
			.run(now());
		const response = await rename(await mint({ '*': { cc: 1 } }));
		expect(response.status).toBe(403);
		expect(await response.text()).toContain('configure cache');
		expect(cacheNames()).toEqual(['pub', 'victim']);
		expect(fixture.sqlite.prepare('SELECT pattern FROM permission_grant').get()!.pattern).toBe(
			'victim'
		);
	});

	it('allows configure on the source plus create on the target', async () => {
		const token = await mint({ victim: { cr: 1 }, renamed: { cc: 1 } });
		expect((await rename(token)).status).toBe(200);
		expect(cacheNames()).toEqual(['pub', 'renamed']);
	});

	it('refuses source configure without target create', async () => {
		const response = await rename(await mint({ victim: { cr: 1 } }));
		expect(response.status).toBe(403);
		expect(cacheNames()).toEqual(['pub', 'victim']);
	});

	it('follows exact-entry precedence over a matching glob', async () => {
		// The exact entry for victim carries no cr, so the wildcard's cr does
		// not apply to it.
		const token = await mint({ '*': { cc: 1, cr: 1 }, victim: { r: 1 } });
		expect((await rename(token)).status).toBe(403);
		const glob = await mint({ 'vic*': { cr: 1 }, renamed: { cc: 1 } });
		expect((await rename(glob)).status).toBe(200);
	});
});

describe('P0: global GC authority is not a cache-name grant', () => {
	const gc = (token: string) => call('/_api/v1/gc?dry_run=1', { method: 'POST', token });
	const gcState = () => count("SELECT count(*) AS n FROM server_config WHERE key LIKE 'gc_%'");

	it('refuses exact delete on a cache named gc without touching the lock', async () => {
		expect((await gc(await mint({ gc: { d: 1, r: 1, cr: 1 } }))).status).toBe(403);
		expect((await gc(await mint({ 'g*': { d: 1 } }))).status).toBe(403);
		expect(gcState()).toBe(0);
	});

	it('accepts the nimbus gc claim', async () => {
		const response = await gc(await mint({}, { gc: true }));
		expect(response.status).toBe(200);
		expect(((await response.json()) as { dry_run: number }).dry_run).toBe(1);
	});

	it('accepts attic-native delete on the literal wildcard', async () => {
		expect((await gc(await mint({ '*': { d: 1 } }))).status).toBe(200);
	});

	it('reserves gc as a cache name for create and rename', async () => {
		await expect(createCache(baseEnv, 'gc', {})).rejects.toMatchObject({ status: 400 });
		await expect(renameCache(baseEnv, 'victim', 'gc')).rejects.toMatchObject({ status: 400 });
	});

	it('spaces manual triggers instance-wide', async () => {
		const token = await mint({}, { gc: true });
		expect((await gc(token)).status).toBe(200);
		const second = await gc(token);
		expect(second.status).toBe(429);
		expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0);
		const t = Date.now();
		expect(await claimManualGcSlot(fixture.db, t + MANUAL_GC_COOLDOWN_MS + 1)).toBeNull();
	});
});

describe('P1: bounded control-plane bodies', () => {
	const admin = () => mint({ '*': { cc: 1, cr: 1, cq: 1 } });

	it('rejects a declared oversize body with 413 before reading it', async () => {
		const response = await call('/_api/v1/cache-config/victim/rename', {
			method: 'POST',
			token: await admin(),
			headers: { 'Content-Length': String(64 * 1024) },
			body: { new_name: 'renamed' }
		});
		expect(response.status).toBe(413);
	});

	it('rejects a streamed oversize body with a false Content-Length', async () => {
		const token = await admin();
		const big = JSON.stringify({ priority: 1, pad: 'x'.repeat(40 * 1024) });
		const response = await handleCacheApi(
			new Request('https://cache.test/_api/v1/cache-config/victim', {
				method: 'PATCH',
				headers: { Authorization: `Bearer ${token}`, 'Content-Length': '10' },
				body: new Response(big).body,
				duplex: 'half'
			} as RequestInit),
			baseEnv
		);
		expect(response.status).toBe(413);
	});

	it('rejects malformed JSON with 400', async () => {
		const response = await call('/_api/v1/cache-config/victim', {
			method: 'PATCH',
			token: await admin(),
			body: '{"priority":'
		});
		expect(response.status).toBe(400);
	});

	it('still accepts an empty or null create body', async () => {
		const token = await admin();
		expect((await call('/_api/v1/cache-config/one', { method: 'POST', token })).status).toBe(200);
		expect(
			(await call('/_api/v1/cache-config/two', { method: 'POST', token, body: 'null' })).status
		).toBe(200);
	});

	it('rejects structurally invalid cache options without writing', async () => {
		const token = await admin();
		for (const body of [
			{ priority: 'high' },
			{ store_dir: `/${'x'.repeat(300)}` },
			{ upstream_cache_key_names: Array(100).fill('k') },
			{ retention_period: -1 }
		]) {
			const response = await call('/_api/v1/cache-config/victim', {
				method: 'PATCH',
				token,
				body
			});
			expect(response.status).toBe(400);
		}
		expect(
			fixture.sqlite.prepare("SELECT priority FROM cache WHERE name = 'victim'").get()
		).toEqual({
			priority: 40
		});
	});

	it('rejects oversized pin and gc-root fields without a D1 write', async () => {
		const token = await admin();
		const hash = 'a'.repeat(32);
		const longNote = 'n'.repeat(1001);
		const root = await call('/_api/v1/gc-root/victim', {
			method: 'POST',
			token,
			body: { store_path_hash: hash, note: longNote }
		});
		expect(root.status).toBe(400);
		const pin = await call('/_api/v1/pin/victim', {
			method: 'POST',
			token,
			body: { name: 'release', store_path_hash: hash, keep_revisions: 1_000_000 }
		});
		expect(pin.status).toBe(400);
		const badNote = await call('/_api/v1/gc-root/victim', {
			method: 'POST',
			token,
			body: { store_path_hash: hash, note: { nested: true } }
		});
		expect(badNote.status).toBe(400);
		expect(count('SELECT count(*) AS n FROM gc_root')).toBe(0);
		expect(count('SELECT count(*) AS n FROM pin')).toBe(0);
	});
});

describe('P1: control-plane request budgets', () => {
	const limiter = (impl: (key: string) => boolean | Promise<boolean>) => {
		const keys: string[] = [];
		const binding = {
			limit: vi.fn(async ({ key }: { key: string }) => {
				keys.push(key);
				return { success: await impl(key) };
			})
		} as unknown as RateLimit;
		return { binding, keys };
	};

	it('charges the per-IP budget before verifying a token', async () => {
		const api = limiter(() => false);
		const env = { ...baseEnv, API_REQUEST_LIMITER: api.binding } as Env;
		const response = await call('/_api/v1/caches', { token: 'not-a-jwt' }, env);
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('10');
		expect(api.keys).toEqual(['api:203.0.113.9']);
		expect((await call('/pub/attic-cache-info', {}, env)).status).toBe(429);
	});

	it('fails closed with a short Retry-After when the limiter errors', async () => {
		const api = limiter(() => {
			throw new Error('limiter down');
		});
		const env = { ...baseEnv, API_REQUEST_LIMITER: api.binding } as Env;
		const response = await call('/_api/v1/caches', {}, env);
		expect(response.status).toBe(503);
		expect(response.headers.get('Retry-After')).toBe('5');
	});

	it('leaves the push hot paths on their own budgets', async () => {
		const api = limiter(() => false);
		const env = { ...baseEnv, API_REQUEST_LIMITER: api.binding } as Env;
		const token = await mint({ victim: { w: 1 } });
		const response = await call(
			'/_api/v1/get-missing-paths',
			{ method: 'POST', token, body: { cache: 'victim', store_path_hashes: ['a'.repeat(32)] } },
			env
		);
		expect(response.status).toBe(200);
		expect(api.keys).toEqual([]);
	});

	it('keys the mutation budget by jti and refuses before any write', async () => {
		const mutation = limiter(() => false);
		const env = { ...baseEnv, API_MUTATION_LIMITER: mutation.binding } as Env;
		const jti = freshJti('mutation');
		const token = await mint({ '*': { cc: 1 } }, { jti });
		const response = await call('/_api/v1/cache-config/newcache', { method: 'POST', token }, env);
		expect(response.status).toBe(429);
		expect(mutation.keys).toEqual([`mutation:jti:${jti}`]);
		expect(count("SELECT count(*) AS n FROM cache WHERE name = 'newcache'")).toBe(0);
		await call('/_api/v1/cache-config/victim', { token }, env);
		expect(mutation.keys).toHaveLength(1);
	});

	it('refuses manual GC once the per-colo GC budget is spent', async () => {
		const gcLimiter = limiter(() => false);
		const env = { ...baseEnv, GC_TRIGGER_LIMITER: gcLimiter.binding } as Env;
		const response = await call(
			'/_api/v1/gc?dry_run=1',
			{ method: 'POST', token: await mint({}, { gc: true }) },
			env
		);
		expect(response.status).toBe(429);
		expect(count("SELECT count(*) AS n FROM server_config WHERE key LIKE 'gc_%'")).toBe(0);
	});

	it('admits when no limiter is bound (local development)', async () => {
		expect(await enforceLimit(baseEnv, undefined, 'k', 'api')).toBeNull();
	});
});

describe('P1: cache list and discovery never share caller-specific views', () => {
	const list = async (token?: string, env: Env = baseEnv) =>
		(
			(await (await call('/_api/v1/caches', { token }, env)).json()) as {
				caches: { name: string }[];
			}
		).caches.map((c) => c.name);

	it('filters the shared memo per caller', async () => {
		expect(await list(await mint({ victim: { r: 1 } }))).toEqual(['pub', 'victim']);
		expect(await list()).toEqual(['pub']);
		expect(await list(await mint({ other: { r: 1 } }))).toEqual(['pub']);
	});

	it('charges only memo misses to the backend-read budget', async () => {
		const backend = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
		const env = { ...baseEnv, BACKEND_READ_LIMITER: backend } as Env;
		await list(undefined, env);
		await list(undefined, env);
		expect(backend.limit).toHaveBeenCalledTimes(1);
	});

	it('invalidates on visibility flips, renames, creates, and deletes', async () => {
		expect(await list()).toEqual(['pub']);
		await configureCache(baseEnv, 'pub', { is_public: false }, { trustAuthorized: true });
		expect(await list()).toEqual([]);
		await configureCache(baseEnv, 'victim', { is_public: true }, { trustAuthorized: true });
		expect(await list()).toEqual(['victim']);
		await renameCache(baseEnv, 'victim', 'moved');
		expect(await list()).toEqual(['moved']);
		await createCache(baseEnv, 'fresh', { is_public: true });
		expect(await list()).toEqual(['fresh', 'moved']);
		await destroyCache(baseEnv, 'moved');
		expect(await list()).toEqual(['fresh']);
	});

	it('serves discovery documents only to readers of the cache', async () => {
		expect((await call('/_api/v1/cache-config/victim')).status).toBe(401);
		expect((await call('/victim/attic-cache-info')).status).toBe(401);
		const reader = await mint({ victim: { r: 1 } });
		const info = await call('/_api/v1/cache-config/victim', { token: reader });
		expect(info.status).toBe(200);
		expect(await info.json()).toMatchObject({ is_public: false, priority: 40 });
		expect((await call('/pub/attic-cache-info')).status).toBe(200);
	});

	it('never publishes the stored keypair, even when it is malformed', async () => {
		const secret = 'not-a-valid-keypair-SECRET';
		fixture.sqlite.prepare("UPDATE cache SET keypair = ? WHERE name = 'pub'").run(secret);
		const response = await call('/pub/attic-cache-info');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(secret);
		expect(JSON.parse(text).public_key).toBeNull();
	});
});

describe('P2: authorization freshness window', () => {
	const WINDOW_MS = 30_000;

	it('stops a revoked token on reads within the memo TTL, and on mutations at once', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		seedUser('erin');
		const jti = freshJti('revoke');
		seedToken(jti, 'erin');
		const token = await mint({ victim: { r: 1, cr: 1 } }, { jti });
		expect((await call('/victim/nix-cache-info', { token })).status).toBe(200);

		fixture.sqlite.prepare('UPDATE api_token SET revoked_at = ? WHERE id = ?').run(now(), jti);
		// Privileged mutations consult the primary on every call.
		const patch = await call('/_api/v1/cache-config/victim', {
			method: 'PATCH',
			token,
			body: { priority: 41 }
		});
		expect(patch.status).toBe(401);
		// Reads ride the memo for at most the documented window.
		expect((await call('/victim/nix-cache-info', { token })).status).toBe(200);
		vi.setSystemTime(Date.now() + WINDOW_MS + 1);
		expect((await call('/victim/nix-cache-info', { token })).status).toBe(401);
	});

	it('stops anonymous reads of a cache made private elsewhere within the memo TTL', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		expect((await call('/pub/nix-cache-info')).status).toBe(200);
		// A flip applied by another isolate: this isolate's memo is not invalidated.
		fixture.sqlite.exec("UPDATE cache SET is_public = 0 WHERE name = 'pub'");
		expect((await call('/pub/nix-cache-info')).status).toBe(200);
		vi.setSystemTime(Date.now() + WINDOW_MS + 1);
		expect((await call('/pub/nix-cache-info')).status).toBe(401);
	});
});
