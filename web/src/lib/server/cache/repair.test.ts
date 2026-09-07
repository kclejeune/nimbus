import { createHash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { memoryBucket, testDatabase } from './test-db';
import { repairChunkFile, stageChunk } from './db';
import { processChunkRepair, replayChunkRepairs, REPAIR_RETIRE_GRACE_MS } from './repair';
import { narBodyTag, serveStore } from './store';
import { convertHashToBase32 } from '../attic/nix-base32';

const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const f of fixtures.splice(0)) f.sqlite.close();
});
function setup(count = 1) {
	const f = testDatabase();
	fixtures.push(f);
	const raw = Buffer.from(
		Array.from({ length: 2048 }, (_, i) => `a reasonably compressible fixture ${i % 53}\n`).join('')
	);
	const encode = (level: number) =>
		zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: level } });
	const old = encode(1),
		replacement = encode(9);
	const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
	const hash = digest(raw);
	f.sqlite.exec(
		`INSERT INTO cache (id,name,keypair,is_public,compression,created_at) VALUES (1,'test','',1,'zstd',datetime('now'))`
	);
	f.sqlite
		.prepare(
			`INSERT INTO chunk (id,state,chunk_hash,chunk_size,file_hash,file_size,compression,remote_file,remote_file_id,created_at) VALUES (1,'V',?,?,?,?,'zstd','{"key":"old"}','old',datetime('now'))`
		)
		.run(`sha256:${hash}`, raw.length, digest(old), old.length);
	f.sqlite
		.prepare(
			`INSERT INTO nar (id,state,nar_hash,nar_size,compression,created_at) VALUES (1,'V',?,?,'zstd',datetime('now'))`
		)
		.run(`sha256:${hash}`, raw.length);
	f.sqlite
		.prepare(
			"INSERT INTO chunkref (nar_id,chunk_id,seq,chunk_hash,compression) VALUES (1,1,0,?,'zstd')"
		)
		.run(`sha256:${hash}`);
	for (let i = 1; i <= count; i++)
		f.sqlite
			.prepare(
				`INSERT INTO object (id,cache_id,nar_id,store_path_hash,store_path,created_at) VALUES (?,1,1,?,?,datetime('now'))`
			)
			.run(i, String(i).padStart(32, '0'), `/nix/store/${String(i).padStart(32, '0')}-test`);
	const { objects, bucket } = memoryBucket(
		new Map([
			['old', old],
			['new', replacement]
		])
	);
	const remove = bucket.delete;
	const env = { ATTIC_DB: f.db, CACHE_BUCKET: bucket } as unknown as App.Platform['env'];
	const file = {
		remote_file: '{"key":"new"}',
		remote_file_id: 'new',
		file_hash: digest(replacement),
		file_size: replacement.length
	};
	const repair = () => repairChunkFile(f.db, 1, '{"key":"old"}', file);
	return { ...f, raw, old, replacement, hash, objects, remove, env, file, repair };
}
it('reconciles a committed CAS after its response is lost', async () => {
	const f = setup();
	let first = true;
	const faulty = {
		prepare: f.db.prepare.bind(f.db),
		batch: async (...args: Parameters<typeof f.db.batch>) => {
			const result = await f.db.batch(...args);
			if (first) {
				first = false;
				throw new Error('Network connection lost');
			}
			return result;
		}
	} as typeof f.db;
	expect(await repairChunkFile(faulty, 1, '{"key":"old"}', f.file)).toBe(true);
	expect(f.sqlite.prepare('SELECT remote_file_id FROM chunk').get()).toMatchObject({
		remote_file_id: 'new'
	});
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(1);
});
it('does not publish a repair for a GC-claimed or missing chunk', async () => {
	const f = setup();
	f.sqlite.exec("UPDATE chunk SET state='D'");
	expect(await f.repair()).toBe(false);
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(0);
	expect(await repairChunkFile(f.db, 999, '{"key":"old"}', f.file)).toBe(false);
});
it('preserves purge progress and covers more than 100 referrers before delayed retirement', async () => {
	const f = setup(301);
	await f.repair();
	let calls = 0;
	const tags: string[] = [];
	const purge = vi.fn(async (batch: string[]) => {
		if (++calls === 2) throw new Error('rate limited');
		tags.push(...batch);
	});
	await expect(processChunkRepair(f.env, 'new', purge)).rejects.toThrow('rate limited');
	expect(
		f.sqlite.prepare('SELECT object_cursor,retire_after FROM chunk_repair').get()
	).toMatchObject({ object_cursor: 25, retire_after: null });
	expect(f.objects.has('old')).toBe(true);
	const success = vi.fn(async (batch: string[]) => {
		tags.push(...batch);
	});
	await processChunkRepair(f.env, 'new', success);
	expect(
		f.sqlite.prepare('SELECT object_cursor,retire_after FROM chunk_repair').get()
	).toMatchObject({ object_cursor: 275, retire_after: null });
	await replayChunkRepairs(f.env, success);
	for (let i = 1; i <= 301; i++)
		expect(tags).toContain(`narinfo:test:${String(i).padStart(32, '0')}`);
	for (const [batch] of [...purge.mock.calls, ...success.mock.calls])
		expect(batch.length).toBeLessThanOrEqual(100);
	expect(tags).not.toContain('candidates');
	expect(tags).toContain(narBodyTag(f.hash));
	expect(f.objects.has('old')).toBe(true);
	vi.useFakeTimers();
	vi.setSystemTime(Date.now() + REPAIR_RETIRE_GRACE_MS + 1);
	await replayChunkRepairs(f.env, success);
	expect(f.objects.has('old')).toBe(false);
	expect(f.objects.has('new')).toBe(true);
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(0);
});
it('keeps a recoverable job when lookup or retirement fails', async () => {
	const f = setup();
	await f.repair();
	const faulty = {
		...f.env,
		ATTIC_DB: {
			prepare(sql: string) {
				if (sql.includes('SELECT DISTINCT')) throw new Error('lookup failed');
				return f.db.prepare(sql);
			}
		}
	} as typeof f.env;
	await expect(processChunkRepair(faulty, 'new', async () => {})).rejects.toThrow('lookup failed');
	expect(f.objects.has('old')).toBe(true);
	await processChunkRepair(f.env, 'new', async () => {});
	vi.useFakeTimers();
	vi.setSystemTime(Date.now() + REPAIR_RETIRE_GRACE_MS + 1);
	f.remove
		.mockRejectedValueOnce(new Error('R2 unavailable'))
		.mockRejectedValueOnce(new Error('R2 unavailable'))
		.mockRejectedValueOnce(new Error('R2 unavailable'));
	const pending = processChunkRepair(f.env, 'new', async () => {});
	pending.catch(() => {});
	await vi.advanceTimersByTimeAsync(5000);
	await expect(pending).rejects.toThrow('R2 unavailable');
	expect(f.objects.has('old')).toBe(true);
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(1);
	await processChunkRepair(f.env, 'new', async () => {});
	expect(f.objects.has('old')).toBe(false);
});
it('evicts public and scoped bodies when another valid zstd encoding replaces a chunk', async () => {
	const f = setup();
	expect(f.old.equals(f.replacement)).toBe(false);
	expect(zstdDecompressSync(f.old)).toEqual(f.raw);
	expect(zstdDecompressSync(f.replacement)).toEqual(f.raw);
	const cache = new Map<string, Response>();
	const read = async (path: string) => {
		if (!cache.has(path))
			cache.set(path, await serveStore(new Request(`https://cache.test${path}`), f.env));
		return cache.get(path)!.clone();
	};
	const narinfo = `/test/${'1'.padStart(32, '0')}.narinfo`;
	const paths = [`/_nar_v2/${f.hash}.nar`, `/_nar_scoped_v2/1/${f.hash}.nar`];
	for (const path of paths) {
		const res = await read(path);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(f.old);
	}
	expect(await (await read(narinfo)).text()).toContain(`FileSize: ${f.old.length}`);
	await f.repair();
	await processChunkRepair(f.env, 'new', async (tags) => {
		for (const [key, res] of cache)
			if (
				res.headers
					.get('Cache-Tag')
					?.split(',')
					.some((tag) => tags.includes(tag))
			)
				cache.delete(key);
	});
	expect(cache.size).toBe(0);
	const info = await (await read(narinfo)).text();
	expect(info).toContain(`FileSize: ${f.replacement.length}`);
	expect(info).toContain(`FileHash: ${convertHashToBase32(`sha256:${f.file.file_hash}`)}`);
	for (const path of paths) {
		const res = await read(path);
		expect(res.headers.get('Content-Length')).toBe(String(f.replacement.length));
		expect(Buffer.from(await res.arrayBuffer())).toEqual(f.replacement);
	}
	expect(f.objects.has('old')).toBe(true);
});

it('journals and retires the key a takeover displaces, and only then', async () => {
	const f = setup();
	const stage = (key: string, file: Uint8Array) =>
		stageChunk(f.db, {
			state: 'P',
			chunk_hash: `sha256:${f.hash}`,
			chunk_size: f.raw.length,
			file_hash: createHash('sha256').update(file).digest('hex'),
			file_size: file.length,
			compression: 'zstd',
			remote_file: JSON.stringify({ key }),
			remote_file_id: key
		});
	// Sharing a valid row moves nothing and journals nothing.
	expect((await stage('shared', f.replacement))?.remote_file).toBe('{"key":"old"}');
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(0);
	// A dead pending row from another encoder whose PUT did land: taking it
	// over displaces 'old', which must be retired rather than leaked.
	f.sqlite.exec("UPDATE chunk SET state='P', holders_count=0");
	const row = await stage('new', f.replacement);
	expect(row).toMatchObject({ state: 'P', remote_file: '{"key":"new"}' });
	expect(f.sqlite.prepare('SELECT * FROM chunk_repair').get()).toMatchObject({
		new_key: 'new',
		chunk_id: 1,
		old_key: 'old'
	});
	await replayChunkRepairs(f.env, async () => {});
	expect(f.objects.has('old')).toBe(false);
	expect(f.objects.has('new')).toBe(true);
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(0);
});

it('refuses to retire a key a chunk row still points at', async () => {
	const f = setup();
	await f.repair();
	await processChunkRepair(f.env, 'new', async () => {});
	f.sqlite.exec('UPDATE chunk SET remote_file=\'{"key":"old"}\', remote_file_id=\'old\'');
	vi.useFakeTimers();
	vi.setSystemTime(Date.now() + REPAIR_RETIRE_GRACE_MS + 1);
	await expect(processChunkRepair(f.env, 'new', async () => {})).rejects.toThrow(
		'still references'
	);
	expect(f.objects.has('old')).toBe(true);
	expect(f.sqlite.prepare('SELECT count(*) AS n FROM chunk_repair').get()!.n).toBe(1);
});

it('rolls back the pointer if its retirement journal cannot be committed', async () => {
	const f = setup();
	f.sqlite.exec(
		"CREATE TRIGGER refuse_repair BEFORE INSERT ON chunk_repair BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END"
	);
	await expect(f.repair()).rejects.toThrow('journal unavailable');
	expect(f.sqlite.prepare('SELECT remote_file_id FROM chunk').get()!.remote_file_id).toBe('old');
});
