import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loseBatchResponses, stubDigestStream, testDatabase } from './test-db';
import { invalidateCacheRow } from './cache-lookup';
import { MemoryBudget } from './platform';
import {
	finishDeduplicated,
	handleBufferedUpload,
	handleCdcQuery,
	handleCdcComplete,
	handleCdcChunkPut,
	handleStreamingUpload,
	handleUploadPath,
	UPLOAD_SLOT_BYTES,
	uploadWeight,
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
			expect(await (await handler(env, ctx, manifest)).json()).toMatchObject({
				kind: 'deduplicated'
			});
		}
		expect(fixture.totalChanges()).toBe(before);
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it('still settles the chunk hold when the publish transaction fails', async () => {
		const batch = fixture.db.batch.bind(fixture.db);
		vi.spyOn(fixture.db, 'batch').mockImplementation(async (stmts) => {
			if (stmts.length > 2) throw new Error('D1_ERROR: constraint failed');
			return batch(stmts);
		});
		const defer = vi.fn();
		await expect(
			handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw, defer)
		).rejects.toThrow('constraint failed');
		// A failed publication releases before it rethrows, never deferred.
		expect(defer).not.toHaveBeenCalled();
		expect(fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get()).toMatchObject({
			state: 'V',
			holders_count: 0
		});
		expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM nar').get()).toMatchObject({ n: 0 });
	});

	it('answers before the success-path hold release, which it defers', async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const batch = fixture.db.batch.bind(fixture.db);
		let calls = 0;
		// stageChunk, publishNar, then the release, held until the gate opens.
		vi.spyOn(fixture.db, 'batch').mockImplementation(async (stmts) => {
			if (++calls === 3) await gate;
			return batch(stmts);
		});
		const deferred: Promise<unknown>[] = [];
		const response = await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw, (work) =>
			deferred.push(work)
		);
		expect(response.status).toBe(200);
		expect(deferred).toHaveLength(1);
		// Published before the answer; only the hold is still outstanding.
		expect(fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get()).toMatchObject({
			state: 'V',
			holders_count: 1
		});
		expect(fixture.sqlite.prepare('SELECT state FROM nar').get()).toMatchObject({ state: 'V' });
		open();
		await Promise.all(deferred);
		expect(fixture.sqlite.prepare('SELECT holders_count FROM chunk').get()).toMatchObject({
			holders_count: 0
		});
	});

	it('defers a dedup hold release only once the object row has landed', async () => {
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		const narId = (fixture.sqlite.prepare('SELECT id FROM nar').get() as { id: number }).id;
		fixture.sqlite.exec(`UPDATE nar SET holders_count = 1 WHERE id = ${narId}`);
		const deferred: Promise<unknown>[] = [];
		const again = { ...manifest.nar_info, store_path_hash: 'b'.repeat(32) };
		expect((await finishDeduplicated(env, again, 1, narId, (w) => deferred.push(w))).status).toBe(
			200
		);
		expect(deferred).toHaveLength(1);
		await Promise.all(deferred);
		expect(fixture.sqlite.prepare('SELECT holders_count FROM nar').get()).toMatchObject({
			holders_count: 0
		});
		expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM object').get()).toMatchObject({
			n: 2
		});
	});

	it("does not release a concurrent upload's chunk hold when settlement fails after committing", async () => {
		// Another upload shares the pending chunk while this one stores it.
		put.mockImplementation(async () => {
			fixture.sqlite.exec('UPDATE chunk SET holders_count = holders_count + 1');
			return {};
		});
		// stageChunk, then publishNar, then settleChunks: the settlement
		// commits and every response for it is lost.
		const batch = loseBatchResponses(fixture.db, (call) => call >= 3);
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		expect(batch).toHaveBeenCalledTimes(3);
		expect(fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get()).toMatchObject({
			state: 'V',
			holders_count: 1
		});
	});

	it('releases a dedup hold exactly once when a committed insert is replayed', async () => {
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		const narId = (fixture.sqlite.prepare('SELECT id FROM nar').get() as { id: number }).id;
		// This upload's hold plus a concurrent upload's.
		fixture.sqlite.exec(`UPDATE nar SET holders_count = 2 WHERE id = ${narId}`);
		const prepare = fixture.db.prepare.bind(fixture.db);
		let lost = false;
		vi.spyOn(fixture.db, 'prepare').mockImplementation((sql: string) => {
			const stmt = prepare(sql);
			if (!sql.startsWith('INSERT INTO object')) return stmt;
			const run = stmt.run.bind(stmt);
			// D1 commits the first attempt, then loses its response.
			stmt.run = (async () => {
				const result = await run();
				if (lost) return result;
				lost = true;
				throw new Error('D1_ERROR: Network connection lost.');
			}) as typeof stmt.run;
			return stmt;
		});
		const again = { ...manifest.nar_info, store_path_hash: 'b'.repeat(32) };
		expect((await finishDeduplicated(env, again, 1, narId)).status).toBe(200);
		expect(lost).toBe(true);
		expect(fixture.sqlite.prepare('SELECT holders_count FROM nar').get()).toMatchObject({
			holders_count: 1
		});
		expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM object').get()).toMatchObject({
			n: 2
		});
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
		expect(await (await handleCdcQuery(env, undefined, manifest)).json()).toEqual({
			kind: 'pending',
			missing_chunk_hashes: [hash],
			proofs: {}
		});
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

	it('buffers no more than the declared length that admission charged for', async () => {
		const req = new Request('https://cache.test/_api/v1/upload-path', {
			method: 'PUT',
			body: new Uint8Array(4096),
			headers: {
				'Content-Length': '3',
				'X-Attic-Nar-Info': JSON.stringify(manifest.nar_info)
			}
		});
		const response = await handleUploadPath(req, env, undefined, () => true);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('declared Content-Length');
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

	it('bounds foreground waiters without sharing their I/O promises', async () => {
		vi.useFakeTimers();
		try {
			const memory = new MemoryBudget(1, 1);
			expect(memory.tryAcquire(1)).toBe(true);
			const queued = memory.acquireBounded(1, 1, 50);
			expect(await memory.acquireBounded(1, 1, 50)).toBe(false);
			memory.release(1);
			await vi.advanceTimersByTimeAsync(50);
			expect(await queued).toBe(true);
			const expired = memory.acquireBounded(1, 1, 50);
			await vi.advanceTimersByTimeAsync(51);
			expect(await expired).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('MemoryBudget', () => {
	it('admits many small bodies where two full slots used to serialize them', () => {
		const budget = new MemoryBudget(2 * UPLOAD_SLOT_BYTES, 8);
		for (let i = 0; i < 8; i++) expect(budget.tryAcquire(uploadWeight(64 * 1024))).toBe(true);
		// The concurrency cap binds before the byte budget does.
		expect(budget.tryAcquire(uploadWeight(64 * 1024))).toBe(false);
	});

	it('keeps the two-pipeline bound for streamed and unknown-length bodies', () => {
		const budget = new MemoryBudget(2 * UPLOAD_SLOT_BYTES, 8);
		expect(uploadWeight(16 * 1024 * 1024)).toBe(UPLOAD_SLOT_BYTES);
		expect(uploadWeight(15 * 1024 * 1024)).toBe(31 * 1024 * 1024);
		expect(budget.tryAcquire(uploadWeight(null))).toBe(true);
		expect(budget.tryAcquire(uploadWeight(null))).toBe(true);
		expect(budget.tryAcquire(uploadWeight(1))).toBe(false);
		budget.release(uploadWeight(null));
		expect(budget.tryAcquire(uploadWeight(1))).toBe(true);
	});

	it('does not let light uploads starve a queued full slot', async () => {
		vi.useFakeTimers();
		try {
			const budget = new MemoryBudget(2 * UPLOAD_SLOT_BYTES, 8);
			const small = uploadWeight(64 * 1024);
			expect(budget.tryAcquire(UPLOAD_SLOT_BYTES)).toBe(true);
			expect(budget.tryAcquire(small)).toBe(true);
			// The remainder fits small bodies but not a second full slot.
			const heavy = budget.acquireBounded(UPLOAD_SLOT_BYTES, 64, 5_000);
			// Later light arrivals queue behind it instead of taking the room.
			expect(budget.tryAcquire(small)).toBe(false);
			const light = budget.acquireBounded(small, 64, 5_000);
			budget.release(small);
			await vi.advanceTimersByTimeAsync(100);
			expect(await heavy).toBe(true);
			// The budget is now exhausted; the light waiter follows once it frees.
			budget.release(UPLOAD_SLOT_BYTES);
			await vi.advanceTimersByTimeAsync(100);
			expect(await light).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not let a canceled waiter block the queue past its timeout', async () => {
		vi.useFakeTimers();
		try {
			const budget = new MemoryBudget(1, 1);
			expect(budget.tryAcquire(1)).toBe(true);
			void budget.acquireBounded(1, 64, 100);
			// A request canceled on disconnect never resumes: its timer is gone and
			// its finally never runs, so its ticket is left at the head.
			vi.clearAllTimers();
			budget.release(1);
			expect(budget.tryAcquire(1)).toBe(false);
			await vi.advanceTimersByTimeAsync(100);
			expect(budget.tryAcquire(1)).toBe(true);
			budget.release(1);
			const next = budget.acquireBounded(1, 64, 100);
			expect(await next).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
