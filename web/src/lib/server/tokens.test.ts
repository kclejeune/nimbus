import { describe, expect, it } from 'vitest';
import { listAllTokens, mintScopedToken } from './tokens';
import { testDatabase } from './cache/test-db';
import { verifyAtticToken } from './attic/token';

const SECRET = btoa('0123456789abcdef0123456789abcdef');

describe('mintScopedToken', () => {
	it('carries the requested bits', async () => {
		const minted = await mintScopedToken(SECRET, 'u1', {
			cacheScope: 'ci-*',
			bits: { r: 1, w: 1, cd: 1 },
			days: 1
		});
		const verified = await verifyAtticToken(minted.token, { hs256SecretBase64: SECRET });
		const perm = verified.caches.get('ci-*')!;
		expect(perm.pull).toBe(true);
		expect(perm.push).toBe(true);
		expect(perm.destroyCache).toBe(true);
		expect(perm.delete).toBe(false);
		expect(verified.jti).toBe(minted.jti);
		expect(verified.gc).toBe(false);
	});

	it('carries the gc claim for a gc-only token', async () => {
		const minted = await mintScopedToken(SECRET, 'u1', {
			cacheScope: '*',
			bits: {},
			gc: true,
			days: 1
		});
		const verified = await verifyAtticToken(minted.token, { hs256SecretBase64: SECRET });
		expect(verified.gc).toBe(true);
		expect(verified.caches.get('*')?.delete).toBe(false);
	});
});

describe('listAllTokens', () => {
	function seed() {
		const t = testDatabase({ admin: true });
		t.seedUser('ada');
		t.seedUser('bob', 'pending');
		const now = Math.floor(Date.now() / 1000);
		const insert = t.sqlite.prepare(
			`INSERT INTO api_token (id, user_id, name, token_hash, permissions, expires_at, revoked_at, created_at)
			 VALUES (?, ?, ?, 'h', '{}', ?, ?, ?)`
		);
		insert.run('t1', 'ada', 'live', null, null, now - 30);
		insert.run('t2', 'ada', 'old', now - 10, null, now - 20);
		insert.run('t3', 'bob', 'held', null, null, now - 10);
		return t.db;
	}

	it('lists every owner newest first, suspending tokens of inactive owners', async () => {
		const { tokens, hasMore } = await listAllTokens(seed());
		expect(hasMore).toBe(false);
		expect(tokens.map((t) => [t.id, t.owner.id, t.status])).toEqual([
			['t3', 'bob', 'suspended'],
			['t2', 'ada', 'expired'],
			['t1', 'ada', 'active']
		]);
	});

	it('pages with a lookahead row instead of a count', async () => {
		const db = seed();
		const first = await listAllTokens(db, { limit: 2, offset: 0 });
		expect(first.tokens.map((t) => t.id)).toEqual(['t3', 't2']);
		expect(first.hasMore).toBe(true);
		const second = await listAllTokens(db, { limit: 2, offset: 2 });
		expect(second.tokens.map((t) => t.id)).toEqual(['t1']);
		expect(second.hasMore).toBe(false);
	});
});
