import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { stubDigestStream, testDatabase } from './test-db';
import { invalidateCacheRow } from './cache-lookup';
import { Semaphore } from './platform';
import {
	handleBufferedUpload,
	handleCdcQuery,
	handleCdcComplete,
	handleCdcChunkPut,
	handleStreamingUpload,
	validateManifest,
	type CdcManifest
} from './upload';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

describe('upload lifecycle', () => {
	let fixture: ReturnType<typeof testDatabase>;
	let env: App.Platform['env'];
	let put: ReturnType<typeof vi.fn>;
	const raw = new Uint8Array([1, 2, 3]);
	const hash = createHash('sha256').update(raw).digest('hex');
	const manifest: CdcManifest = {
		nar_info: {
			cache: 'test',
			store_path_hash: 'a'.repeat(32),
			store_path: `/nix/store/${'a'.repeat(32)}-test`,
			references: [],
			sigs: [],
			system: null,
			deriver: null,
			ca: null,
			nar_hash: `sha256:${hash}`
		},
		nar_size: raw.length,
		chunks: [{ hash, size: raw.length }]
	};
	beforeEach(() => {
		invalidateCacheRow();
		fixture = testDatabase();
		fixture.sqlite.exec(
			"INSERT INTO cache (name, keypair, compression, created_at) VALUES ('test', '', 'zstd', datetime('now'))"
		);
		put = vi.fn(async () => {
			const row = fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get();
			expect(row).toMatchObject({ state: 'P', holders_count: 1 });
			return {};
		});
		env = { ATTIC_DB: fixture.db, CACHE_BUCKET: { put } } as unknown as App.Platform['env'];
	});
	afterEach(() => {
		fixture.sqlite.close();
		vi.unstubAllGlobals();
	});

	it('records ownership before PUT and retains it when PUT fails', async () => {
		put.mockRejectedValue(new Error('R2 unavailable'));
		await expect(handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).rejects.toThrow(
			'R2 unavailable'
		);
		expect(
			fixture.sqlite.prepare('SELECT state, holders_count, remote_file FROM chunk').get()
		).toMatchObject({ state: 'P', holders_count: 0, remote_file: expect.stringContaining(hash) });
	});

	it('a successful upload publishes only after PUT and CDC retries do no writes or purges', async () => {
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		expect(put).toHaveBeenCalledOnce();
		expect(fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get()).toMatchObject({
			state: 'V',
			holders_count: 0
		});
		const before = fixture.totalChanges();
		const waitUntil = vi.fn();
		const ctx = { waitUntil } as unknown as App.Platform['ctx'];
		for (const handler of [handleCdcQuery, handleCdcComplete]) {
			expect(await (await handler(env, ctx, 'https://cache.test', manifest)).json()).toMatchObject({
				kind: 'deduplicated'
			});
		}
		expect(fixture.totalChanges()).toBe(before);
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it('charges the storage budget only for bytes actually written', async () => {
		const limit = vi.fn(async () => ({ success: true }));
		env.STORAGE_WRITE_LIMITER = { limit } as unknown as NonNullable<
			typeof env.STORAGE_WRITE_LIMITER
		>;
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		expect(limit).toHaveBeenCalledOnce();
		const again = { ...manifest.nar_info, store_path_hash: 'b'.repeat(32) };
		expect((await handleBufferedUpload(env, again, 1, 'zstd', raw)).status).toBe(200);
		expect(limit).toHaveBeenCalledOnce();
		expect(put).toHaveBeenCalledOnce();
	});

	it('a fresh CDC query is strictly read-only', async () => {
		const before = fixture.totalChanges();
		expect(
			await (await handleCdcQuery(env, undefined, 'https://cache.test', manifest)).json()
		).toEqual({ kind: 'pending', missing_chunk_hashes: [hash], proofs: {} });
		expect(fixture.totalChanges()).toBe(before);
		expect(put).not.toHaveBeenCalled();
	});

	it('rejects an oversized compressed chunk before reading or storing it', async () => {
		const cancel = vi.fn();
		const req = new Request('https://cache.test/chunk?cache=test', {
			method: 'PUT',
			body: new ReadableStream({ cancel }),
			duplex: 'half',
			headers: { 'Content-Length': String(18 * 1024 * 1024) }
		} as RequestInit);
		expect((await handleCdcChunkPut(req, env, hash, 'test')).status).toBe(413);
		expect(cancel).toHaveBeenCalledOnce();
		expect(put).not.toHaveBeenCalled();
	});

	it('leaves mismatched streaming bytes tracked and unheld for GC', async () => {
		stubDigestStream();
		const body = new Response(raw).body!;
		expect(
			(
				await handleStreamingUpload(
					env,
					body,
					{ ...manifest.nar_info, nar_hash: 'b'.repeat(64) },
					1,
					'zstd'
				)
			).status
		).toBe(400);
		expect(put).toHaveBeenCalledOnce();
		expect(fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get()).toMatchObject({
			state: 'V',
			holders_count: 0
		});
		expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM object').get()!.n).toBe(0);
	});

	it.each([null, {}, { ...manifest, nar_info: null }, { ...manifest, chunks: [null] }])(
		'rejects malformed manifests without throwing',
		(body) => {
			expect(validateManifest(body as CdcManifest)?.status).toBe(400);
		}
	);

	it('does not queue memory-heavy work inside the isolate', () => {
		const memory = new Semaphore(1);
		expect(memory.tryAcquire()).toBe(true);
		expect(memory.tryAcquire()).toBe(false);
		memory.release();
		expect(memory.tryAcquire()).toBe(true);
	});
	it('bounds foreground waiters without sharing their I/O promises', async () => {
		vi.useFakeTimers();
		try {
			const memory = new Semaphore(1);
			expect(memory.tryAcquire()).toBe(true);
			const queued = memory.acquireBounded(1, 50);
			expect(await memory.acquireBounded(1, 50)).toBe(false);
			memory.release();
			await vi.advanceTimersByTimeAsync(50);
			expect(await queued).toBe(true);
			const expired = memory.acquireBounded(1, 50);
			await vi.advanceTimersByTimeAsync(51);
			expect(await expired).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
