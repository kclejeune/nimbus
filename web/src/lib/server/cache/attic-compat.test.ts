import { SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryBucket, stubDigestStream, testDatabase } from './test-db';

vi.mock('./compression', async () => (await import('./test-db')).fakeCompression());

import { handleCacheApi } from './router';
import { invalidateCacheRow } from './cache-lookup';
import { clearUpstreamsMemo } from './missing-paths';
import { configureCache, createCache } from './cache-config';

// Request bodies below are what the stock attic client (7a19204) sends.

type Env = App.Platform['env'];

const fixture = testDatabase({ admin: true });
const key = new TextEncoder().encode('attic-compat-test-secret');
const env = {
	ATTIC_DB: fixture.db,
	CACHE_BUCKET: memoryBucket().bucket,
	JWT_HS256_SECRET_BASE64: Buffer.from(key).toString('base64'),
	CACHE_BASE_URL: 'https://cache.test'
} as unknown as Env;

const ATTIC_UA = 'Attic/attic-client (nixpkgs)';
const allBits = { r: 1, w: 1, d: 1, cc: 1, cr: 1, cq: 1, cd: 1 };
let token: string;

function call(
	path: string,
	init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Response> {
	return handleCacheApi(
		new Request(`https://cache.test${path}`, {
			method: init.method ?? 'GET',
			headers: {
				'CF-Connecting-IP': '203.0.113.7',
				Authorization: `Bearer ${token}`,
				...init.headers
			},
			body:
				init.body === undefined
					? undefined
					: init.body instanceof Uint8Array
						? (init.body as Uint8Array<ArrayBuffer>)
						: JSON.stringify(init.body)
		}),
		env
	);
}

const retentionDays = (name: string) =>
	fixture.sqlite.prepare('SELECT retention_period AS d FROM cache WHERE name = ?').get(name)!.d;

beforeEach(async () => {
	fixture.sqlite.exec('DELETE FROM object; DELETE FROM nar; DELETE FROM cache');
	invalidateCacheRow();
	clearUpstreamsMemo();
	token = await new SignJWT({ 'https://jwt.attic.rs/v1': { caches: { '*': allBits } } })
		.setProtectedHeader({ alg: 'HS256' })
		.setJti(`compat-${Math.random()}`)
		.setExpirationTime('1h')
		.sign(key);
});

async function atticCreate(name: string) {
	return call(`/_api/v1/cache-config/${name}`, {
		method: 'POST',
		body: {
			keypair: 'Generate',
			is_public: false,
			store_dir: '/nix/store',
			priority: 41,
			upstream_cache_key_names: ['cache.nixos.org-1']
		}
	});
}

describe('attic client compatibility', () => {
	it('creates a cache from an attic body and describes it in attic shapes', async () => {
		expect((await atticCreate('compat')).status).toBe(200);
		const info = (await (await call('/_api/v1/cache-config/compat')).json()) as Record<
			string,
			unknown
		>;
		expect(info).toMatchObject({
			substituter_endpoint: 'https://cache.test/compat',
			api_endpoint: 'https://cache.test/',
			priority: 41,
			upstream_cache_key_names: ['cache.nixos.org-1']
		});
		expect(info).not.toHaveProperty('retention_period');
	});

	it('accepts attic retention periods and reports them back in seconds', async () => {
		await atticCreate('compat');
		const patch = (retention_period: unknown) =>
			call('/_api/v1/cache-config/compat', {
				method: 'PATCH',
				body: { priority: 30, retention_period }
			});

		expect((await patch({ Period: 30 * 86_400 })).status).toBe(200);
		expect(retentionDays('compat')).toBe(30);
		const info = (await (await call('/_api/v1/cache-config/compat')).json()) as Record<
			string,
			unknown
		>;
		expect(info.retention_period).toEqual({ Period: 30 * 86_400 });

		expect((await patch({ Period: 3_600 })).status).toBe(200);
		expect(retentionDays('compat')).toBe(1);

		expect((await patch('Global')).status).toBe(200);
		expect(retentionDays('compat')).toBeNull();

		await patch({ Period: 7 * 86_400 });
		expect((await patch({ Period: 0 })).status).toBe(200);
		expect(retentionDays('compat')).toBeNull();

		expect((await patch({ Period: -1 })).status).toBe(400);
	});

	it('maps keypair "Generate" to a rotation', async () => {
		await atticCreate('compat');
		const before = fixture.sqlite.prepare("SELECT keypair FROM cache WHERE name = 'compat'").get()!
			.keypair;
		await configureCache(env, 'compat', { keypair: 'Generate' } as never, {
			trustAuthorized: true
		});
		const after = fixture.sqlite.prepare("SELECT keypair FROM cache WHERE name = 'compat'").get()!
			.keypair;
		expect(after).not.toBe(before);
	});

	it('stores the retention a cache is created with', async () => {
		await createCache(env, 'dash', { retention_period: 14 });
		expect(retentionDays('dash')).toBe(14);
	});

	it("accepts attic's cache-name alphabet", async () => {
		expect((await atticCreate('My_Cache+1')).status).toBe(200);
		expect((await atticCreate('_leading')).status).toBe(400);
	});

	it('answers a closure larger than one lookup statement', async () => {
		await atticCreate('compat');
		const hashes = Array.from({ length: 12_345 }, (_, i) =>
			createHash('sha256')
				.update(String(i))
				.digest('hex')
				.slice(0, 32)
				.replace(/[eotu]/g, 'a')
		);
		const res = await call('/_api/v1/get-missing-paths', {
			method: 'POST',
			body: { cache: 'compat', store_path_hashes: hashes }
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { missing_paths: string[] };
		expect(new Set(body.missing_paths)).toEqual(new Set(hashes));
	});

	it('spells the upload result kind the way each client expects', async () => {
		stubDigestStream();
		await atticCreate('compat');
		const nar = new Uint8Array([1, 2, 3]);
		const narHash = createHash('sha256').update(nar).digest('hex');
		const upload = (headers: Record<string, string>) =>
			call('/_api/v1/upload-path', {
				method: 'PUT',
				body: nar,
				headers: {
					'Content-Length': String(nar.length),
					'X-Attic-Nar-Info': JSON.stringify({
						cache: 'compat',
						store_path_hash: 'a'.repeat(32),
						store_path: `/nix/store/${'a'.repeat(32)}-compat`,
						references: [],
						system: null,
						deriver: null,
						sigs: [],
						ca: null,
						nar_hash: `sha256:${narHash}`,
						nar_size: nar.length
					}),
					...headers
				}
			});

		expect(await (await upload({ 'User-Agent': ATTIC_UA })).json()).toMatchObject({
			kind: 'Uploaded'
		});
		expect(await (await upload({ 'User-Agent': ATTIC_UA })).json()).toMatchObject({
			kind: 'Deduplicated'
		});
		expect(await (await upload({})).json()).toMatchObject({ kind: 'deduplicated' });
	});
});
