import { SignJWT } from 'jose';
import { handleCacheApi } from './router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { memoryBucket, stubDigestStream, testDatabase } from './test-db';
import { invalidateCacheRow } from './cache-lookup';
import {
	handleBufferedUpload,
	handleCdcQuery,
	handleCdcComplete,
	handleCdcChunkPut,
	handleStreamingUpload,
	PublicationRejectedError,
	validateManifest,
	type CdcManifest
} from './upload';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

import { issueChunkProof, verifyChunkProof } from './chunk-proof';
import { findNarWithChunks, createObject, type NewObject } from './db';
import { serveStore } from './store';
import { clearUpstreamsMemo } from './missing-paths';

describe('audit security regressions', () => {
	const fixture = testDatabase();
	const raw = new Uint8Array([1, 2, 3]);
	const hash = createHash('sha256').update(raw).digest('hex');
	const manifest: CdcManifest = {
		nar_info: {
			cache: 'victim',
			store_path_hash: 'a'.repeat(32),
			store_path: `/nix/store/${'a'.repeat(32)}-test`,
			references: [],
			sigs: [],
			system: null,
			deriver: null,
			ca: null,
			nar_hash: `sha256:${hash}`
		},
		nar_size: 3,
		chunks: [{ hash, size: 3 }]
	};
	const env = {
		SESSION_SECRET: 'regression-test-secret',
		ATTIC_DB: fixture.db,
		CACHE_BUCKET: {
			put: async () => ({}),
			get: async () => ({ body: new Response(raw).body }),
			head: async () => ({})
		}
	} as unknown as App.Platform['env'];
	beforeEach(() => {
		invalidateCacheRow();
		clearUpstreamsMemo();
		fixture.sqlite.exec(
			'DELETE FROM chunk_repair; DELETE FROM object; DELETE FROM chunkref; DELETE FROM nar; DELETE FROM chunk; DELETE FROM cache_upstream; DELETE FROM cache; DELETE FROM upstream_check; DELETE FROM upstream;'
		);
		fixture.sqlite.exec(
			"INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'victim','',0,'zstd',datetime('now')), (2,'attacker','',1,'zstd',datetime('now'))"
		);
	});
	afterEach(() => vi.unstubAllGlobals());
	it('rejects attaching a private NAR into a public cache without possession', async () => {
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		expect(await findNarWithChunks(fixture.db, [manifest.nar_info.nar_hash])).toBeNull();
		const attack = {
			...manifest,
			nar_info: { ...manifest.nar_info, cache: 'attacker' },
			chunks: [{ hash: 'f'.repeat(64), size: 3 }]
		};
		expect((await handleCdcComplete(env, undefined, 'https://cache.test', attack)).status).toBe(
			403
		);
		expect(await findNarWithChunks(fixture.db, [manifest.nar_info.nar_hash])).toBeNull();
	});
	it('rejects foreign chunks even when the manifest claims a different whole hash', async () => {
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		const attack = {
			...manifest,
			nar_info: { ...manifest.nar_info, cache: 'attacker', nar_hash: `sha256:${'b'.repeat(64)}` }
		};
		expect((await handleCdcComplete(env, undefined, 'https://cache.test', attack)).status).toBe(
			403
		);
		const found = await findNarWithChunks(fixture.db, [attack.nar_info.nar_hash]);
		expect(found).toBeNull();
	});
	it('upstream outages return uncached 503 instead of poisoning the negative cache', async () => {
		fixture.sqlite.exec(
			"INSERT INTO upstream (url,public_key,ttl,default_mode,enforced,position,nix_default,created_at) VALUES ('https://upstream.test','unused',3600,'redirect',0,0,0,datetime('now'))"
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('unavailable', { status: 503 }))
		);
		const res = await serveStore(
			new Request(`https://cache.test/attacker/${'c'.repeat(32)}.narinfo`),
			env
		);
		expect(res.status).toBe(503);
		expect(res.headers.get('Cache-Control')).toContain('no-store');
	});
	it.each([false, true])(
		'checks the whole NAR hash after valid chunk possession (forged=%s)',
		async (forged) => {
			stubDigestStream();
			await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw);
			const receiptResponse = await putChunk(env);
			expect(receiptResponse.status).toBe(200);
			const { proof } = (await receiptResponse.json()) as { proof: string };
			const own = {
				...manifest,
				nar_info: {
					...manifest.nar_info,
					cache: 'attacker',
					nar_hash: forged ? `sha256:${'b'.repeat(64)}` : manifest.nar_info.nar_hash
				},
				chunks: [{ hash, size: 3, proof }]
			};
			const response = await handleCdcComplete(env, undefined, 'https://cache.test', own);
			expect(response.status).toBe(forged ? 400 : 200);
			const found = await findNarWithChunks(fixture.db, [own.nar_info.nar_hash]);
			if (forged) expect(found).toBeNull();
			else expect(found?.nar.nar_hash).toBe(own.nar_info.nar_hash);
			expect(fixture.sqlite.prepare('SELECT holders_count FROM chunk').get()).toMatchObject({
				holders_count: 0
			});
		}
	);
	it('binds receipts to cache, bytes and size, and expires them', async () => {
		const cache = { id: 1, keypair: '' };
		const proof = await issueChunkProof(env, cache, hash, 3);
		expect(await verifyChunkProof(env, cache, { hash, size: 3, proof })).toBe(true);
		expect(await verifyChunkProof(env, { id: 2, keypair: '' }, { hash, size: 3, proof })).toBe(
			false
		);
		expect(await verifyChunkProof(env, cache, { hash, size: 4, proof })).toBe(false);
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 25 * 3600000);
		expect(await verifyChunkProof(env, cache, { hash, size: 3, proof })).toBe(false);
		vi.useRealTimers();
	});
	it.each(['key', 'mode', 'deleted', 'valid'])(
		'rechecks upstream publication trust atomically: %s',
		async (change) => {
			await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw);
			fixture.sqlite.exec(
				"INSERT INTO upstream (id,url,public_key,ttl,default_mode,enforced,position,nix_default,created_at) VALUES (1,'https://upstream.test','key',3600,'persist',0,0,0,datetime('now'))"
			);
			const nar = fixture.sqlite.prepare('SELECT id FROM nar').get()!;
			const object = trustedObject(Number(nar.id));
			if (change === 'key') fixture.sqlite.exec("UPDATE upstream SET public_key = 'new-key'");
			if (change === 'mode')
				fixture.sqlite.exec(
					"INSERT INTO cache_upstream (cache_id,upstream_id,mode) VALUES (2,1,'redirect')"
				);
			if (change === 'deleted')
				fixture.sqlite.exec("UPDATE cache SET deleted_at = datetime('now') WHERE id = 2");
			expect(await createObject(fixture.db, object)).toBe(change === 'valid');
			expect(
				fixture.sqlite.prepare('SELECT count(*) AS n FROM object WHERE cache_id = 2').get()!.n
			).toBe(change === 'valid' ? 1 : 0);
			// An identical guarded re-publish changes no row yet is not a
			// rejection: the attachment it asked for is in place.
			if (change === 'valid') expect(await createObject(fixture.db, object)).toBe(true);
		}
	);
	it('reuses stored chunks only through read entitlement, never through push access alone', async () => {
		// The private victim cache holds the chunk.
		expect((await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		const into = (cache: string) => ({ ...manifest, nar_info: { ...manifest.nar_info, cache } });
		const query = (cache: string, canPull: (name: string) => boolean) =>
			handleCdcQuery(env, undefined, 'https://cache.test', into(cache), canPull).then(
				(r) =>
					r.json() as Promise<{ missing_chunk_hashes: string[]; proofs: Record<string, string> }>
			);

		// Push access to a public destination says nothing about the victim's bytes.
		expect(await query('attacker', () => false)).toEqual({
			kind: 'pending',
			missing_chunk_hashes: [hash],
			proofs: {}
		});
		// Pull permission on the source is read access: the chunk is reported
		// present with a receipt for the destination, and completion succeeds
		// without a single chunk upload.
		const entitled = await query('attacker', (name) => name === 'victim');
		expect(entitled.missing_chunk_hashes).toEqual([]);
		expect(Object.keys(entitled.proofs)).toEqual([hash]);
		expect(
			await verifyChunkProof(
				env,
				{ id: 2, keypair: '' },
				{ hash, size: 3, proof: entitled.proofs[hash] }
			)
		).toBe(true);
		stubDigestStream();
		const own = { ...into('attacker'), chunks: [{ hash, size: 3, proof: entitled.proofs[hash] }] };
		expect((await handleCdcComplete(env, undefined, 'https://cache.test', own)).status).toBe(200);
		expect(await findNarWithChunks(fixture.db, [manifest.nar_info.nar_hash])).not.toBeNull();

		// A destination that already holds the chunk discloses nothing new by
		// re-attaching it, so push-only access there is enough.
		const again = await handleCdcQuery(
			env,
			undefined,
			'https://cache.test',
			{ ...manifest, nar_info: { ...manifest.nar_info, store_path_hash: 'd'.repeat(32) } },
			() => false
		).then(
			(r) => r.json() as Promise<{ missing_chunk_hashes: string[]; proofs: Record<string, string> }>
		);
		expect(again.missing_chunk_hashes).toEqual([]);
		expect(Object.keys(again.proofs)).toEqual([hash]);
	});
	it('reports a rejected pull-through publication as an outcome instead of success', async () => {
		fixture.sqlite.exec(
			"INSERT INTO upstream (id,url,public_key,ttl,default_mode,enforced,position,nix_default,created_at) VALUES (1,'https://upstream.test','key',3600,'persist',0,0,0,datetime('now'))"
		);
		const info = {
			...manifest.nar_info,
			cache: 'attacker',
			publishTrust: { upstreamId: 1, publicKey: 'key', url: 'https://upstream.test' }
		};
		// Trust changed between ingest start and publication.
		fixture.sqlite.exec("UPDATE upstream SET public_key = 'rotated'");
		await expect(handleBufferedUpload(env, info, 2, 'zstd', raw)).rejects.toBeInstanceOf(
			PublicationRejectedError
		);
		expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM object').get()!.n).toBe(0);
		// This call's own NAR row is rolled back; nothing is left half-published.
		expect(fixture.sqlite.prepare('SELECT state FROM nar').get()).toMatchObject({ state: 'D' });

		// The shared-NAR path (createObject on an existing NAR) reports the
		// refusal without touching the NAR someone else may hold.
		fixture.sqlite.exec("UPDATE upstream SET public_key = 'key'");
		await handleBufferedUpload(env, manifest.nar_info, 1, 'zstd', raw);
		const nar = fixture.sqlite.prepare("SELECT id FROM nar WHERE state = 'V'").get()!;
		fixture.sqlite.exec("UPDATE upstream SET public_key = 'rotated'");
		expect(await createObject(fixture.db, trustedObject(Number(nar.id)))).toBe(false);
		expect(fixture.sqlite.prepare('SELECT state FROM nar WHERE id = ?').get(nar.id)).toMatchObject({
			state: 'V'
		});
	});
	/** The fixture env over a real in-memory bucket instead of the R2 spy. */
	function liveEnv() {
		const { objects, bucket } = memoryBucket();
		return {
			objects,
			bucket,
			live: { ...env, CACHE_BUCKET: bucket } as unknown as App.Platform['env']
		};
	}
	/** An object published from the test upstream into cache 2. */
	const trustedObject = (narId: number): NewObject => ({
		cache_id: 2,
		nar_id: narId,
		store_path_hash: 'b'.repeat(32),
		store_path: '/nix/store/test',
		references: [],
		sigs: [],
		system: null,
		deriver: null,
		ca: null,
		source: 'pullthrough:https://upstream.test',
		created_by: null,
		publishTrust: { upstreamId: 1, publicKey: 'key', url: 'https://upstream.test' }
	});
	/** A chunk PUT of the fixture bytes, bound to the attacker cache. */
	const putChunk = (target: App.Platform['env']) =>
		handleCdcChunkPut(
			new Request('https://cache.test/chunk', { method: 'PUT', body: raw }),
			target,
			hash,
			'attacker'
		);
	const rowKey = () =>
		JSON.parse(String(fixture.sqlite.prepare('SELECT remote_file FROM chunk').get()!.remote_file))
			.key as string;

	it('repairs a chunk whose stored bytes vanished or failed verification', async () => {
		const { objects, live } = liveEnv();
		stubDigestStream();
		expect((await handleBufferedUpload(live, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		const original = rowKey();
		const putJson = () =>
			putChunk(live).then((r) => r.json() as Promise<{ proof: string; repaired?: boolean }>);
		const complete = (proof: string, storePathHash = manifest.nar_info.store_path_hash) =>
			handleCdcComplete(live, undefined, 'https://cache.test', {
				...manifest,
				nar_info: { ...manifest.nar_info, cache: 'attacker', store_path_hash: storePathHash },
				chunks: [{ hash, size: 3, proof }]
			});

		// GC (or anything else) removed the object out from under a valid row:
		// the re-upload lands under a new versioned key and the row moves to it.
		objects.delete(original);
		const first = await putJson();
		expect(first.repaired).toBe(true);
		expect(rowKey()).not.toBe(original);
		expect(objects.has(rowKey())).toBe(true);
		expect((await complete(first.proof)).status).toBe(200);

		// Stored bytes that contradict the row: completion marks the row
		// damaged (no deletion — a concurrent repair may own the key by now)
		// and asks for the chunk again; a plain dedup PUT no longer satisfies it.
		const damagedKey = rowKey();
		objects.set(damagedKey, new Uint8Array([9, 9, 9]));
		const proof = (await putJson()).proof;
		const conflict = await complete(proof, 'f'.repeat(32));
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ missing_chunk_hashes: [hash] });
		expect(objects.has(damagedKey)).toBe(true);
		expect(
			fixture.sqlite.prepare('SELECT file_hash, holders_count FROM chunk').get()
		).toMatchObject({ file_hash: null, holders_count: 0 });
		const repaired = await putJson();
		expect(repaired.repaired).toBe(true);
		expect(rowKey()).not.toBe(damagedKey);
		// Retirement waits for confirmed invalidation and a reader grace period.
		expect(objects.has(damagedKey)).toBe(true);
		expect(objects.has(rowKey())).toBe(true);
		expect((await complete(repaired.proof, 'f'.repeat(32))).status).toBe(200);
	});
	it.each(['missing', 'damaged', 'transfer', 'nar-hash'])(
		'releases chunk holds without publishing after %s verification failure',
		async (failure) => {
			const { objects, bucket, live } = liveEnv();
			stubDigestStream();
			await handleBufferedUpload(live, manifest.nar_info, 1, 'zstd', raw);
			const proof = await issueChunkProof(live, { id: 2, keypair: null }, hash, raw.length);
			if (failure === 'missing') objects.clear();
			if (failure === 'damaged') objects.set(rowKey(), new Uint8Array([9, 9, 9]));
			if (failure === 'transfer') {
				vi.spyOn(bucket, 'get').mockImplementation(async () => ({
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new Error('transfer interrupted'));
						}
					})
				}));
			}
			const completion = handleCdcComplete(live, undefined, 'https://cache.test', {
				...manifest,
				nar_info: {
					...manifest.nar_info,
					cache: 'attacker',
					nar_hash: failure === 'nar-hash' ? `sha256:${'0'.repeat(64)}` : manifest.nar_info.nar_hash
				},
				chunks: [{ hash, size: raw.length, proof }]
			});
			if (failure === 'transfer') {
				await expect(completion).rejects.toThrow('Chunk storage temporarily unavailable');
			} else {
				expect((await completion).status).toBe(failure === 'nar-hash' ? 400 : 409);
			}
			expect(fixture.sqlite.prepare('SELECT holders_count FROM chunk').get()).toMatchObject({
				holders_count: 0
			});
			expect(
				fixture.sqlite.prepare('SELECT count(*) AS n FROM object WHERE cache_id = 2').get()!.n
			).toBe(0);
		}
	);
	it('keeps the winning R2 object when D1 loses the committed repair response', async () => {
		const { objects, live } = liveEnv();
		await handleBufferedUpload(live, manifest.nar_info, 1, 'zstd', raw);
		objects.clear();
		let first = true;
		const faulty = {
			...fixture.db,
			batch: async (...args: Parameters<typeof fixture.db.batch>) => {
				const result = await fixture.db.batch(...args);
				if (first) {
					first = false;
					throw new Error('Network connection lost');
				}
				return result;
			}
		} as typeof fixture.db;
		const res = await putChunk({ ...live, ATTIC_DB: faulty });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ repaired: true });
		expect([...objects.keys()]).toEqual([rowKey()]);
		expect(fixture.sqlite.prepare('SELECT new_key FROM chunk_repair').get()!.new_key).toBe(
			rowKey()
		);
	});
	it('elects one winner when repairs race and never strands the row', async () => {
		const { objects, live } = liveEnv();
		expect((await handleBufferedUpload(live, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		objects.clear();
		const putJson = () =>
			putChunk(live).then((r) => r.json() as Promise<{ proof: string; repaired?: boolean }>);
		const results = await Promise.all([putJson(), putJson(), putJson()]);
		expect(results.every((r) => r.proof)).toBe(true);
		expect(results.filter((r) => r.repaired).length).toBeLessThanOrEqual(1);
		// Exactly the row's object survives; losers removed their own uploads.
		expect([...objects.keys()]).toEqual([rowKey()]);
		expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM chunk').get()!.n).toBe(1);
	});
	it('stores afresh when a repair loses to GC claiming the row', async () => {
		const { objects, live } = liveEnv();
		expect((await handleBufferedUpload(live, manifest.nar_info, 1, 'zstd', raw)).status).toBe(200);
		objects.clear();
		// GC reaps the row between the PUT's lookup and its compare-and-set.
		let reaped = false;
		const reaping = {
			...fixture.db,
			batch: async (...args: Parameters<typeof fixture.db.batch>) => {
				if (!reaped) {
					reaped = true;
					fixture.sqlite.exec('DELETE FROM chunkref; DELETE FROM chunk');
				}
				return fixture.db.batch(...args);
			}
		} as typeof fixture.db;
		const res = await putChunk({ ...live, ATTIC_DB: reaping });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deduplicated: false });
		// The loser's object is gone and only the fresh row's object remains.
		expect(rowKey()).toMatch(/^chunk\/[0-9a-f]{2}\/[0-9a-f]{64}\.[0-9a-f-]{36}\.zst$/);
		expect([...objects.keys()]).toEqual([rowKey()]);
		expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(0);
	});
	it('serves a public cache NAR only while that cache currently holds it', async () => {
		const store = vi.fn(async (request: Request) => {
			const path = new URL(request.url).pathname;
			if (path.startsWith('/_meta/nar/'))
				return new Response(JSON.stringify(holders), {
					headers: { 'Content-Type': 'application/json' }
				});
			// A body that survived a failed withdrawal purge.
			return new Response('cached bytes', { status: 200 });
		});
		const ctx = {
			exports: { CachedStore: { fetch: store } },
			waitUntil: () => {}
		} as unknown as import('./platform').ExecutionContext;
		const request = () =>
			handleCacheApi(new Request(`https://cache.test/attacker/nar/${hash}.nar`), env, ctx);
		// Held only by the (now private) victim: not reachable via public 'attacker'.
		let holders = [{ id: 1, name: 'victim', priority: 0, is_public: 0 }];
		expect((await request()).status).toBe(404);
		expect(
			store.mock.calls.every(([r]) => new URL((r as Request).url).pathname.startsWith('/_meta/'))
		).toBe(true);
		holders = [{ id: 2, name: 'attacker', priority: 0, is_public: 1 }];
		expect((await request()).status).toBe(200);
	});
	it('does not expose internal metadata and retention endpoints through the gateway', async () => {
		for (const path of [
			'/_meta/path/hash',
			'/_manifest/public/hash',
			'/_touch/1/hash',
			'/_chunk/key',
			'/_nar_v2/hash'
		]) {
			const response = await handleCacheApi(new Request(`https://cache.test${path}`), env);
			expect(response.status).toBe(404);
		}
	});
	it('fails closed before a mutation when token revocation storage is unavailable', async () => {
		const key = new TextEncoder().encode('token-test-secret');
		const token = await new SignJWT({ 'https://jwt.attic.rs/v1': { caches: { '*': { cc: 1 } } } })
			.setProtectedHeader({ alg: 'HS256' })
			.setJti('unavailable-test')
			.setExpirationTime('1h')
			.sign(key);
		const unavailable = {
			...env,
			JWT_HS256_SECRET_BASE64: Buffer.from(key).toString('base64'),
			ATTIC_DB: {
				prepare: () => {
					throw new Error('database unavailable');
				}
			}
		} as unknown as App.Platform['env'];
		const response = await handleCacheApi(
			new Request('https://cache.test/_api/v1/cache-config/new', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: '{}'
			}),
			unavailable
		);
		expect(response.status).toBe(503);
		expect(response.headers.get('Cache-Control')).toContain('no-store');
	});
});
