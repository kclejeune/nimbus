import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

/** Real SQLite SQL semantics, not a simulation of D1 replication or workerd. */
export function testDatabase() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../../../../schema/schema.sql', import.meta.url), 'utf8'));
	const totalChanges = () => Number(sqlite.prepare('SELECT total_changes() AS n').get()!.n);
	const prepare = (sql: string) => {
		let params: Record<string, SQLInputValue> = {};
		const stmt = {
			bind(...values: SQLInputValue[]) {
				params = Object.fromEntries(values.map((v, i) => [String(i + 1), v]));
				return stmt;
			},
			execute() {
				const before = totalChanges();
				const results = sqlite.prepare(sql).all(params);
				return {
					results,
					success: true,
					meta: {
						changes: totalChanges() - before,
						last_row_id: Number(sqlite.prepare('SELECT last_insert_rowid() AS id').get()!.id)
					}
				};
			},
			async all() {
				return stmt.execute();
			},
			async first() {
				return (await stmt.all()).results[0] ?? null;
			},
			async run() {
				return stmt.all();
			}
		};
		return stmt;
	};
	const binding = {
		prepare,
		withSession() {
			return binding;
		},
		async batch(stmts: ReturnType<typeof prepare>[]) {
			sqlite.exec('BEGIN');
			try {
				const results = [];
				for (const stmt of stmts) results.push(stmt.execute());
				sqlite.exec('COMMIT');
				return results;
			} catch (e) {
				sqlite.exec('ROLLBACK');
				throw e;
			}
		}
	};
	return { sqlite, db: binding as unknown as D1Database, totalChanges };
}

/** Node has no crypto.DigestStream; streaming uploads and CDC completion
 * hash through it. Restored by vi.unstubAllGlobals / the test's afterEach. */
export function stubDigestStream(): void {
	class DigestStream extends WritableStream<BufferSource> {
		digest: Promise<ArrayBuffer>;
		constructor() {
			const hash = createHash('sha256');
			let resolve!: (value: ArrayBuffer) => void;
			const digest = new Promise<ArrayBuffer>((r) => {
				resolve = r;
			});
			super({
				write: (value) => {
					hash.update(new Uint8Array(value as ArrayBuffer));
				},
				close: () => {
					resolve(Uint8Array.from(hash.digest()).buffer);
				}
			});
			this.digest = digest;
		}
	}
	vi.stubGlobal('crypto', {
		subtle: crypto.subtle,
		randomUUID: crypto.randomUUID.bind(crypto),
		DigestStream
	});
}

/** Map-backed stand-in for the R2 binding; every method is a spy. */
export function memoryBucket(objects = new Map<string, Uint8Array>()) {
	const bucket = {
		put: vi.fn(async (key: string, data: Uint8Array) => {
			objects.set(key, new Uint8Array(data));
			return {};
		}),
		get: vi.fn(async (key: string) => {
			const bytes = objects.get(key);
			if (!bytes) return null;
			return {
				body: new Response(new Uint8Array(bytes)).body,
				size: bytes.length,
				json: async () => JSON.parse(new TextDecoder().decode(bytes))
			};
		}),
		head: vi.fn(async (key: string) => (objects.has(key) ? {} : null)),
		delete: vi.fn(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		}),
		list: vi.fn(async ({ prefix = '', limit = 1000 }: { prefix?: string; limit?: number }) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.slice(0, limit)
				.map((key) => ({ key }))
		}))
	};
	return { objects, bucket };
}

/** The compression module without wasm: identity zstd, sha256 hashes, one
 * memory slot. `vi.mock('./compression', fakeCompression)`. */
export async function fakeCompression() {
	const { Semaphore } = await import('./platform');
	const digest = async (data: Uint8Array) =>
		Buffer.from(await crypto.subtle.digest('SHA-256', data as BufferSource)).toString('hex');
	return {
		wasmMemorySlots: new Semaphore(1),
		initZstd: async () => {},
		zstdDecompress: (data: Uint8Array) => data,
		extensionFor: () => '.zst',
		uploadCompressionFor: () => 'zstd',
		compressBuffer: async (data: Uint8Array) => ({
			data,
			narHash: await digest(data),
			narSize: data.length,
			fileHash: await digest(data),
			fileSize: data.length
		})
	};
}
