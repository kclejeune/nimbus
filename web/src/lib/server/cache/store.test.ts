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
import { newFixedLengthStream } from './platform';

// The actual Workers primitive is exercised separately in workerd. Node's
// streams still let these tests cover pump errors and the caching policy.
vi.mock('./platform', async (importOriginal) => ({
	...(await importOriginal<typeof import('./platform')>()),
	newFixedLengthStream: vi.fn(() => new TransformStream<Uint8Array, Uint8Array>())
}));

describe('store hardening', () => {
	const fixture = testDatabase();
	afterEach(() => {
		vi.clearAllMocks();
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
		expect(new URL(keys[0]).pathname).toBe(`/_nar_v2/${hash}.nar`);
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
		const fetch = vi.fn(async (request: Request): Promise<Response> =>
			new URL(request.url).pathname.startsWith('/_manifest/')
				? serveStore(request, { ATTIC_DB: db } as App.Platform['env'])
				: new Response('chunk')
		);
		const tasks: Promise<unknown>[] = [];
		const ctx = {
			exports: { CachedStore: { fetch, purgeTags: async () => {} } },
			waitUntil: (p: Promise<unknown>) => tasks.push(p)
		} as unknown as import('./platform').ExecutionContext;
		const env = { ATTIC_DB: db, CACHE_BUCKET: { get } } as unknown as App.Platform['env'];
		const response = await serveStore(
			new Request(`https://cache.test/_nar_v2/${hash}.nar`),
			env,
			ctx
		);
		expect(await response.text()).toBe('chunkchunk');
		expect(newFixedLengthStream).toHaveBeenCalledWith(600 * 1024 * 1024);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		await Promise.all(tasks);
		expect(
			fetch.mock.calls
				.filter(([r]) => !(r as Request).url.includes('/_manifest/'))
				.map(([r]) => (r as Request).url)
		).toEqual([
			'https://cache.internal/_chunk/chunk%2F0',
			'https://cache.internal/_chunk/chunk%2F1'
		]);
		expect(get).not.toHaveBeenCalled();
	});
	async function streamResponse(
		sizes: (number | null)[],
		bodies: (ReadableStream | null)[],
		cacheStatus = 200
	) {
		const hash = 'b'.repeat(64);
		const chunks = sizes.map((file_size, seq) => ({
			file_size,
			remote_file: JSON.stringify({ key: `chunk/${seq}` }),
			remote_file_id: `chunk/${seq}`
		}));
		const tasks: Promise<unknown>[] = [];
		const ctx = {
			exports: {
				CachedStore: {
					fetch: async (request: Request) => {
						const path = new URL(request.url).pathname;
						if (path.startsWith('/_chunk/')) {
							if (cacheStatus !== 200)
								return new Response('cache unavailable', { status: cacheStatus });
							const key = decodeURIComponent(path.slice('/_chunk/'.length));
							return new Response(bodies[Number(key.split('/')[1])]);
						}
						return Response.json({
							nar: { nar_hash: `sha256:${hash}`, num_chunks: chunks.length },
							chunks
						});
					}
				}
			},
			waitUntil: (p: Promise<unknown>) => tasks.push(p)
		} as unknown as import('./platform').ExecutionContext;
		const env = {
			CACHE_BUCKET: {
				get: async (key: string) => {
					const body = bodies[Number(key.split('/')[1])];
					return body ? { body } : null;
				}
			}
		} as unknown as App.Platform['env'];
		return {
			response: await serveStore(new Request(`https://cache.test/_nar_v2/${hash}.nar`), env, ctx),
			tasks
		};
	}

	it('enforces the compressed total for cacheable multi-chunk responses', async () => {
		const { response, tasks } = await streamResponse(
			[3, 3],
			[new Response('one').body!, new Response('two').body!]
		);
		expect(response.headers.get('Content-Length')).toBe('6');
		expect(response.headers.get('Cache-Control')).toContain('immutable');
		expect(await response.text()).toBe('onetwo');
		await Promise.all(tasks);
		expect(newFixedLengthStream).toHaveBeenCalledWith(6);
	});

	it('does not cache assembled bodies without a known compressed length', async () => {
		const { response, tasks } = await streamResponse(
			[null, 3],
			[new Response('one').body!, new Response('two').body!]
		);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.has('Content-Length')).toBe(false);
		expect(await response.text()).toBe('onetwo');
		await Promise.all(tasks);
		expect(newFixedLengthStream).not.toHaveBeenCalled();
	});

	it('errors the response body when an R2 chunk disconnects mid-transfer', async () => {
		let reads = 0;
		const broken = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (reads++ === 0) controller.enqueue(new TextEncoder().encode('part'));
				else controller.error(new Error('Network connection lost'));
			}
		});
		const { response, tasks } = await streamResponse([3, 8], [new Response('one').body!, broken]);
		await expect(response.arrayBuffer()).rejects.toThrow('Network connection lost');
		await Promise.all(tasks);
	});

	it('errors the response body when a later stored chunk is missing', async () => {
		const { response, tasks } = await streamResponse([3, 3], [new Response('one').body!, null]);
		await expect(response.arrayBuffer()).rejects.toThrow('File not found in storage');
		await Promise.all(tasks);
	});

	it('reports the failing chunk and actual R2 source after a chunk-cache fallback', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const broken = new ReadableStream<Uint8Array>({
				pull(c) {
					c.error(new Error('R2 body disconnected'));
				}
			});
			const { response, tasks } = await streamResponse(
				[null, 8],
				[new Response('one').body!, broken],
				502
			);
			await expect(response.arrayBuffer()).rejects.toThrow('R2 body disconnected');
			await Promise.all(tasks);
			expect(error.mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(
				expect.objectContaining({
					event: 'nimbus.stream',
					status: 'error',
					narHash: 'b'.repeat(64),
					chunk: { index: 1, key: 'chunk/1', source: 'r2' },
					phase: 'pipe',
					error: 'R2 body disconnected',
					completedChunks: 1
				})
			);
		} finally {
			error.mockRestore();
		}
	});
});
