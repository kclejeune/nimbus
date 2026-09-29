import { describe, expect, it } from 'vitest';
import { listAllTokens, listUserTokens, mintScopedToken } from './tokens';
import {
	NO_TOKEN_FILTERS,
	parseTokenFilters,
	tokenFilterParams,
	TOKEN_STATUSES
} from '$lib/token-filters';
import { testDatabase } from './cache/test-db';
import { formatDate } from '$lib/format';
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

describe('token filters', () => {
	const DAY = 86400;
	const at = (date: string) => Date.parse(`${date}T12:00:00Z`) / 1000;
	const now = Math.floor(Date.now() / 1000);

	function seed() {
		const t = testDatabase({ admin: true });
		t.seedUser('ada');
		t.seedUser('bob', 'pending');
		t.seedUser('cy', 'active', 'admin');
		const insert = t.sqlite.prepare(
			`INSERT INTO api_token (id, user_id, name, token_hash, permissions, expires_at, revoked_at, created_at)
			 VALUES (?, ?, ?, 'h', '{}', ?, ?, ?)`
		);
		// Every status, never-expiring rows stored both as NULL and 0, and
		// creation dates straddling the range bounds used below.
		insert.run('live', 'ada', 'live', now + DAY, null, at('2026-03-01'));
		insert.run('never', 'ada', 'never', null, null, at('2026-03-10'));
		insert.run('zero', 'cy', 'zero', 0, null, at('2026-03-31'));
		insert.run('old', 'ada', 'old', now - DAY, null, at('2026-04-01'));
		insert.run('gone', 'cy', 'gone', now + DAY, now - 5, at('2026-02-28'));
		insert.run('held', 'bob', 'held', null, null, at('2026-03-15'));
		insert.run('heldold', 'bob', 'heldold', now - DAY, null, at('2026-03-16'));
		return t.db;
	}
	const filters = (query: string, everyone = true) =>
		parseTokenFilters(new URLSearchParams(query), everyone);
	const ids = (tokens: { id: string }[]) => tokens.map((t) => t.id).sort();

	it('labels each token and filters by status with the same rule', async () => {
		const db = seed();
		// Revoked beats expired beats suspended; NULL and 0 never expire; an
		// admin owner counts as active whatever their status.
		const expected: Record<string, string> = {
			live: 'active',
			never: 'active',
			zero: 'active',
			old: 'expired',
			gone: 'revoked',
			held: 'suspended',
			heldold: 'expired'
		};
		const { tokens } = await listAllTokens(db);
		expect(Object.fromEntries(tokens.map((t) => [t.id, t.status]))).toEqual(expected);
		for (const status of TOKEN_STATUSES) {
			const { tokens } = await listAllTokens(db, { filters: filters(`status=${status}`) });
			const want = Object.keys(expected).filter((id) => expected[id] === status);
			expect(ids(tokens), status).toEqual(want.sort());
		}
		// A deactivated user's own list shows their tokens as suspended too.
		expect((await listUserTokens(db, 'bob')).map((t) => [t.id, t.status])).toEqual([
			['heldold', 'expired'],
			['held', 'suspended']
		]);
		const mine = await listUserTokens(db, 'ada', filters('status=expired', false));
		expect(ids(mine)).toEqual(['old']);
	});

	it('filters by owner and by inclusive UTC date ranges', async () => {
		const db = seed();
		const list = async (q: string) =>
			ids((await listAllTokens(db, { filters: filters(q) })).tokens);
		expect(await list('user=bob')).toEqual(['held', 'heldold']);
		expect(await list('created_from=2026-03-01&created_to=2026-03-31')).toEqual(
			['held', 'heldold', 'live', 'never', 'zero'].sort()
		);
		expect(await list('created_to=2026-02-28')).toEqual(['gone']);
		// Never-expiring tokens (NULL or 0) fall in no expiry range, even an
		// open-ended one.
		const tomorrow = formatDate(now + DAY);
		expect(await list(`expires_to=${tomorrow}`)).toEqual(['gone', 'heldold', 'live', 'old'].sort());
		expect(await list(`expires_from=${tomorrow}`)).toEqual(['gone', 'live']);
		expect(await list('user=bob&status=suspended')).toEqual(['held']);
	});

	it('drops malformed values and owner-only filters outside the everyone view', () => {
		expect(filters('status=bogus&created_from=2026-13-45&expires_to=soon&user=')).toEqual(
			NO_TOKEN_FILTERS
		);
		const own = filters('status=suspended&user=bob&created_from=2026-03-01', false);
		expect(own).toEqual({ ...NO_TOKEN_FILTERS, createdFrom: '2026-03-01' });
		expect(tokenFilterParams(filters('status=revoked&user=bob')).toString()).toBe(
			'status=revoked&user=bob'
		);
	});
});
