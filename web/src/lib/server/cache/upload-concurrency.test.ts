import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { invalidateCacheRow } from './cache-lookup';
import { withWasmSlot } from './compression';
import { memoryBucket, stubDigestStream, testDatabase } from './test-db';
import {
	admitUpload,
	handleCdcChunkPut,
	handleCdcComplete,
	UPLOAD_SLOT_BYTES,
	uploadMemory,
	type CdcManifest
} from './upload';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const chunkRequest = (body: BodyInit) =>
	new Request('https://cache.test/chunk', { method: 'PUT', body, duplex: 'half' } as RequestInit);
let fixture: ReturnType<typeof testDatabase>;
let storage: ReturnType<typeof memoryBucket>;
let env: App.Platform['env'];
beforeEach(() => {
	invalidateCacheRow();
	fixture = testDatabase();
	fixture.sqlite.exec(
		"INSERT INTO cache (name,keypair,compression,created_at) VALUES ('test','','zstd',datetime('now'))"
	);
	storage = memoryBucket();
	env = {
		ATTIC_DB: fixture.db,
		CACHE_BUCKET: storage.bucket,
		SESSION_SECRET: 'upload-concurrency-test-secret'
	} as unknown as App.Platform['env'];
	stubDigestStream();
});
afterEach(() => {
	fixture.sqlite.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function seed() {
	const raws = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
	const chunks = [];
	for (const raw of raws) {
		const hash = hashOf(raw);
		const response = await handleCdcChunkPut(chunkRequest(raw), env, hash, 'test');
		const { proof } = (await response.json()) as { proof: string };
		chunks.push({ hash, size: raw.length, proof });
	}
	const all = new Uint8Array([...raws[0], ...raws[1]]);
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
			nar_hash: `sha256:${hashOf(all)}`
		},
		nar_size: all.length,
		chunks
	};
	return { manifest, raws };
}

it('leaves a WASM slot available while a chunk PUT waits for its request body', async () => {
	const reading = deferred<void>();
	const resume = deferred<void>();
	const raw = new Uint8Array([1, 2, 3]);
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				reading.resolve();
				await resume.promise;
				controller.enqueue(raw);
				controller.close();
			}
		},
		{ highWaterMark: 0 }
	);
	const request = chunkRequest(body);
	const release = await admitUpload(request, 'chunk');
	const uploading = handleCdcChunkPut(request, env, hashOf(raw), 'test', undefined, release);
	try {
		await reading.promise;
		expect(await withWasmSlot(async () => 'available')).toBe('available');
	} finally {
		resume.resolve();
		try {
			expect((await uploading).status).toBe(200);
		} finally {
			release();
		}
	}
});

it('returns raw-buffer memory while a verified chunk waits for R2 persistence', async () => {
	const persisting = deferred<void>();
	const resume = deferred<void>();
	const put = storage.bucket.put.getMockImplementation()!;
	vi.spyOn(storage.bucket, 'put').mockImplementation(async (...args) => {
		persisting.resolve();
		await resume.promise;
		return put(...args);
	});
	const raw = new Uint8Array([1, 2, 3]);
	const request = chunkRequest(raw);
	const blocker = await admitUpload(request, 'chunk');
	const release = await admitUpload(request, 'chunk');
	const uploading = handleCdcChunkPut(request, env, hashOf(raw), 'test', undefined, release);
	let acquired = false;
	try {
		await persisting.promise;
		acquired = uploadMemory.tryAcquire(UPLOAD_SLOT_BYTES / 2);
		expect(acquired).toBe(true);
	} finally {
		if (acquired) uploadMemory.release(UPLOAD_SLOT_BYTES / 2);
		resume.resolve();
		try {
			expect((await uploading).status).toBe(200);
		} finally {
			release();
			blocker();
		}
	}
});

it('prefetches the next R2 chunk without holding WASM or exceeding the shared byte budget', async () => {
	const { manifest, raws } = await seed();
	const reading = deferred<void>();
	const resume = deferred<void>();
	const get = storage.bucket.get.getMockImplementation()!;
	let calls = 0;
	vi.spyOn(storage.bucket, 'get').mockImplementation(async (key) => {
		const object = await get(key);
		if (++calls !== 1) return object;
		return {
			...object!,
			body: new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						reading.resolve();
						await resume.promise;
						controller.enqueue(raws[0]);
						controller.close();
					}
				},
				{ highWaterMark: 0 }
			)
		};
	});
	const completing = handleCdcComplete(env, undefined, manifest);
	let acquired = false;
	try {
		await reading.promise;
		expect(storage.bucket.get).toHaveBeenCalledTimes(2);
		expect(await withWasmSlot(async () => 'available')).toBe('available');
		acquired = uploadMemory.tryAcquire(UPLOAD_SLOT_BYTES);
		expect(acquired).toBe(true);
		expect(uploadMemory.tryAcquire(1)).toBe(false);
	} finally {
		if (acquired) uploadMemory.release(UPLOAD_SLOT_BYTES);
		resume.resolve();
		expect((await completing).status).toBe(200);
	}
	expect(
		fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM chunk WHERE holders_count != 0').get()!.n
	).toBe(0);
});

it('cancels unused read-ahead and releases memory and holds after corrupt stored bytes', async () => {
	const { manifest } = await seed();
	const keys = [...storage.objects.keys()];
	storage.objects.set(keys[0], new Uint8Array([9, 9, 9]));
	const cancelled = vi.fn();
	const get = storage.bucket.get.getMockImplementation()!;
	vi.spyOn(storage.bucket, 'get').mockImplementation(async (key) =>
		key === keys[1]
			? {
					body: new ReadableStream<Uint8Array>({ cancel: cancelled }),
					size: 3,
					json: async () => null
				}
			: get(key)
	);
	const response = await handleCdcComplete(env, undefined, manifest);
	expect(response.status).toBe(409);
	expect(cancelled).toHaveBeenCalledOnce();
	expect(
		fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM chunk WHERE holders_count != 0').get()!.n
	).toBe(0);
	expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM nar').get()!.n).toBe(0);
	const acquired = uploadMemory.tryAcquire(2 * UPLOAD_SLOT_BYTES);
	if (acquired) uploadMemory.release(2 * UPLOAD_SLOT_BYTES);
	expect(acquired).toBe(true);
});

it('does not buffer completion bodies while admission is full, and releases holds on refusal', async () => {
	const { manifest } = await seed();
	const read = vi.fn();
	const cancelled = vi.fn();
	vi.spyOn(storage.bucket, 'get').mockImplementation(async () => ({
		body: new ReadableStream<Uint8Array>({ pull: read, cancel: cancelled }, { highWaterMark: 0 }),
		size: 3,
		json: async () => null
	}));
	const held = 2 * UPLOAD_SLOT_BYTES;
	expect(uploadMemory.tryAcquire(held)).toBe(true);
	vi.useFakeTimers();
	try {
		const completion = handleCdcComplete(env, undefined, manifest).catch((error: Error) => error);
		await vi.waitFor(() => expect(storage.bucket.get).toHaveBeenCalledTimes(2));
		expect(read).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5100);
		expect(await completion).toMatchObject({ message: 'Upload memory busy; retry shortly' });
		expect(read).not.toHaveBeenCalled();
		expect(cancelled).toHaveBeenCalledTimes(2);
		expect(
			fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM chunk WHERE holders_count != 0').get()!.n
		).toBe(0);
		expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM nar').get()!.n).toBe(0);
	} finally {
		uploadMemory.release(held);
		vi.useRealTimers();
	}
	const acquired = uploadMemory.tryAcquire(held);
	if (acquired) uploadMemory.release(held);
	expect(acquired).toBe(true);
});
