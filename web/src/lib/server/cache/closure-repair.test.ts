import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { testDatabase } from './test-db';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

import { uncoveredReferences } from './closure-repair';
import { pruneUpstreamChecks, syncObjectRefs } from './gc';
import { handleCacheApi } from './router';
import { clearUpstreamsMemo, type Upstream } from './missing-paths';

const hash = (i: number) => String(i).padStart(32, '0');
const name = (i: number) => `${hash(i)}-path`;
const old = new Date(Date.now() - 7 * 86400_000).toISOString();

function fixture() {
	const f = testDatabase();
	f.sqlite.exec(`
		INSERT INTO cache (id, name, keypair, created_at) VALUES (1, 'one', 'k', '${old}'), (2, 'two', 'k', '${old}');
		INSERT INTO nar (id, state, nar_hash, nar_size, created_at) VALUES (1, 'V', 'n', 1, '${old}');
	`);
	const object = (i: number, refs: number[], cache = 1, at = old) => {
		f.sqlite
			.prepare(
				`INSERT INTO object (cache_id, nar_id, store_path_hash, store_path, refs, created_at)
			VALUES (?, 1, ?, ?, ?, ?)`
			)
			.run(cache, hash(i), `/nix/store/${name(i)}`, JSON.stringify(refs.map(name)), at);
	};
	return { ...f, object };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	clearUpstreamsMemo();
});

describe('closure recovery', () => {
	it('pages unique dependency names and sees a repair before the next ref sync', async () => {
		const f = fixture();
		const refs = Array.from({ length: 103 }, (_, i) => i + 1);
		f.object(500, refs);
		f.object(501, [1]);
		await syncObjectRefs(f.db);
		const first = await uncoveredReferences(f.db, 1, []);
		expect(first.references).toHaveLength(100);
		expect(first.references[0]).toEqual({
			hash: hash(1),
			store_path: `/nix/store/${name(1)}`,
			referrers: 2
		});
		expect(first.next_cursor).toBe(hash(100));
		const second = await uncoveredReferences(f.db, 1, [], first.next_cursor!);
		expect(second.references.map((r) => r.hash)).toEqual([hash(101), hash(102), hash(103)]);
		expect(second.next_cursor).toBeNull();
		f.object(1, []);
		expect((await uncoveredReferences(f.db, 1, [])).references[0].hash).toBe(hash(2));
		f.sqlite.close();
	});

	it('respects upstream TTL, cache scope, push grace, and detached parents', async () => {
		const f = fixture();
		f.object(500, [1, 2, 3, 4]);
		f.object(2, [], 2); // Another private cache does not cover cache one.
		f.object(501, [5], 1, new Date().toISOString());
		f.object(502, [6]);
		f.sqlite.exec(`UPDATE object SET detached_at = '${old}' WHERE store_path_hash = '${hash(502)}';
			INSERT INTO upstream (id, url, public_key, ttl, created_at) VALUES (1, 'https://up.test', 'k', 86400, '${old}'), (2, 'https://off.test', 'k', 86400, '${old}');`);
		const verdict = f.sqlite.prepare('INSERT INTO upstream_check VALUES (?, ?, 1, ?)');
		verdict.run(1, hash(1), new Date().toISOString());
		verdict.run(1, hash(3), old); // Expired coverage must be rechecked.
		verdict.run(2, hash(4), new Date().toISOString()); // Disabled for this cache.
		await syncObjectRefs(f.db);
		const upstream = { id: 1, ttl: 86400 } as Upstream;
		expect((await uncoveredReferences(f.db, 1, [upstream])).references.map((r) => r.hash)).toEqual([
			hash(2),
			hash(3),
			hash(4)
		]);
		f.sqlite.close();
	});

	it('requires pull and push authority and rejects malformed pagination cursors', async () => {
		const f = fixture();
		f.object(500, [1]);
		await syncObjectRefs(f.db);
		const key = new TextEncoder().encode('closure-repair-test');
		const env = {
			ATTIC_DB: f.db,
			JWT_HS256_SECRET_BASE64: Buffer.from(key).toString('base64')
		} as App.Platform['env'];
		const call = async (bits: Record<string, number>, suffix = '') => {
			const token = await new SignJWT({ 'https://jwt.attic.rs/v1': { caches: { one: bits } } })
				.setProtectedHeader({ alg: 'HS256' })
				.setExpirationTime('1h')
				.sign(key);
			return handleCacheApi(
				new Request(`https://cache.test/_api/v1/cache-integrity/one${suffix}`, {
					headers: { Authorization: `Bearer ${token}` }
				}),
				env
			);
		};
		expect((await call({ r: 1 })).status).toBe(403);
		expect((await call({ w: 1 })).status).toBe(403);
		expect((await call({ r: 1, w: 1 }, '?after=bad')).status).toBe(400);
		const good = await call({ r: 1, w: 1 });
		expect(good.status).toBe(200);
		expect(((await good.json()) as { references: unknown[] }).references).toHaveLength(1);
		f.sqlite.close();
	});
});

it('GC retains positive verdicts through the upstream TTL and prunes obsolete rows', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-19T03:00:00Z'));
	const f = fixture();
	f.sqlite.exec(`INSERT INTO upstream (id, url, public_key, ttl, created_at) VALUES
		(1, 'https://archive.test', 'k', 31536000, '${old}'),
		(2, 'https://volatile.test', 'k', 86400, '${old}');`);
	const verdict = f.sqlite.prepare('INSERT INTO upstream_check VALUES (?, ?, ?, ?)');
	const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
	verdict.run(1, hash(1), 1, daysAgo(100)); // Was pruned 265 days too early.
	verdict.run(1, hash(2), 2, daysAgo(100));
	verdict.run(1, hash(3), 1, daysAgo(366));
	verdict.run(2, hash(4), 1, daysAgo(100));
	verdict.run(2, hash(5), 1, daysAgo(10)); // Keep the 90-day floor for short TTLs.
	verdict.run(1, hash(6), 0, daysAgo(2));
	verdict.run(1, hash(7), 0, daysAgo(0.5));
	await pruneUpstreamChecks(f.db);
	expect(
		f.sqlite
			.prepare('SELECT store_path_hash FROM upstream_check ORDER BY store_path_hash')
			.all()
			.map((r) => r.store_path_hash)
	).toEqual([hash(1), hash(2), hash(5), hash(7)]);
	f.sqlite.close();
});
