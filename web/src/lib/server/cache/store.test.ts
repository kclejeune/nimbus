import { afterEach, describe, expect, it, vi } from 'vitest';
import { narStoreUrl, serveStore } from './store';
import { testDatabase } from './test-db';
import {
	createNar,
	createObject,
	insertChunkRefStmt,
	dbRun,
	publishChunk,
	releaseChunkLocksById,
	stageChunk
} from './db';
import { AdmissionError, CLIENT_IP_HEADER } from './admission';

describe('store hardening', () => {
	const fixture = testDatabase();
	afterEach(() => {
		fixture.sqlite.exec(
			'DELETE FROM object; DELETE FROM chunkref; DELETE FROM nar; DELETE FROM chunk; DELETE FROM cache'
		);
	});
	it('folds extension and query aliases without sharing private cache scopes', () => {
		const request = new Request('https://cache.test/nar/example.nar?bust=1');
		const hash = 'a'.repeat(64);
		const keys = ['.nar', '.nar.zst', '.random.nar.zst'].map(
			(suffix) => narStoreUrl(request, { id: 1, is_public: 1 }, hash + suffix).href
		);
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).not.toContain('?');
		const privateUrl = (id: number) =>
			narStoreUrl(request, { id, is_public: 0 }, hash + '.nar').href;
		expect(privateUrl(1)).not.toBe(privateUrl(2));
		expect(privateUrl(1)).not.toBe(keys[0]);
	});
	it('charges cold reads to the client the gateway stamped, before touching D1', async () => {
		const prepare = vi.fn();
		const keys: string[] = [];
		const env = {
			ATTIC_DB: { prepare },
			BACKEND_READ_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					keys.push(key);
					return { success: false };
				}
			}
		} as unknown as App.Platform['env'];
		await expect(
			serveStore(
				new Request('https://cache.test/test/a.narinfo', {
					headers: { [CLIENT_IP_HEADER]: '203.0.113.7' }
				}),
				env
			)
		).rejects.toBeInstanceOf(AdmissionError);
		expect(keys).toEqual(['backend-read:203.0.113.7']);
		expect(prepare).not.toHaveBeenCalled();
	});
	it('streams oversized NARs through independently cached chunks', async () => {
		const { db, sqlite } = fixture;
		sqlite.exec(
			"INSERT INTO cache (id, name, keypair, is_public, created_at) VALUES (1, 'test', '', 1, datetime('now'))"
		);
		const hash = 'a'.repeat(64);
		const nar = await createNar(db, {
			state: 'V',
			nar_hash: `sha256:${hash}`,
			nar_size: 700 * 1024 * 1024,
			compression: 'zstd',
			num_chunks: 2
		});
		await createObject(db, {
			cache_id: 1,
			nar_id: nar,
			store_path_hash: 'a'.repeat(32),
			store_path: '/nix/store/test',
			references: [],
			system: null,
			deriver: null,
			sigs: [],
			ca: null,
			source: 'push',
			created_by: null
		});
		for (let i = 0; i < 2; i++) {
			const staged = await stageChunk(db, {
				state: 'P',
				chunk_hash: String(i),
				chunk_size: 400 * 1024 * 1024,
				file_hash: String(i),
				file_size: 300 * 1024 * 1024,
				compression: 'zstd',
				remote_file: JSON.stringify({ key: `chunk/${i}` }),
				remote_file_id: `chunk/${i}`
			});
			await publishChunk(db, staged!.id);
			await releaseChunkLocksById(db, [staged!.id]);
			await dbRun(insertChunkRefStmt(db, nar, i, null, String(i), 'zstd'));
		}
		const get = vi.fn();
		const fetch = vi.fn(async (_request: Request) => new Response('chunk'));
		const tasks: Promise<unknown>[] = [];
		const ctx = {
			exports: { CachedStore: { fetch, purgeTags: async () => {} } },
			waitUntil: (p: Promise<unknown>) => tasks.push(p)
		} as unknown as import('./platform').ExecutionContext;
		const env = { ATTIC_DB: db, CACHE_BUCKET: { get } } as unknown as App.Platform['env'];
		const response = await serveStore(new Request(`https://cache.test/_nar/${hash}.nar`), env, ctx);
		expect(await response.text()).toBe('chunkchunk');
		await Promise.all(tasks);
		expect(fetch.mock.calls.map(([r]) => (r as Request).url)).toEqual([
			'https://chunks.internal/_chunk/chunk%2F0',
			'https://chunks.internal/_chunk/chunk%2F1'
		]);
		expect(get).not.toHaveBeenCalled();
	});
});
