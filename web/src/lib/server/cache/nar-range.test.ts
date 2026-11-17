import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadManifest, chargeBackendRead } from './metadata';
import { serveLargeNarRange, CACHEABLE_NAR_BYTES } from './nar-range';
import type { ExecutionContext } from './platform';
vi.mock('./metadata', () => ({
	loadManifest: vi.fn(),
	chargeBackendRead: vi.fn(async () => {}),
	internalRequest: (_env: unknown, path: string) => new Request('https://cache.test' + path)
}));
vi.mock('./platform', async (importOriginal) => ({
	...(await importOriginal<typeof import('./platform')>()),
	newFixedLengthStream: () => new TransformStream()
}));
const chunkSize = 200 * 1024 * 1024;
const size = 3 * chunkSize;
const get = vi.fn(async (key: string, options: { range: { offset: number; length: number } }) => ({
	size: chunkSize,
	body: new Response(new Uint8Array(options.range.length).fill(Number(key))).body!
}));
const env = { CACHE_BUCKET: { get } } as unknown as App.Platform['env'];
let tasks: Promise<unknown>[];
let ctx: ExecutionContext;
const request = (range: string, extra: HeadersInit = {}) =>
	new Request('https://cache.test/nar/hash.nar', { headers: { Range: range, ...extra } });
beforeEach(() => {
	tasks = [];
	ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p) } as ExecutionContext;
	vi.mocked(loadManifest).mockResolvedValue({
		nar: { num_chunks: 3 },
		chunks: [1, 2, 3].map((id) => ({
			file_size: chunkSize,
			remote_file: JSON.stringify({ key: String(id) })
		}))
	} as Awaited<ReturnType<typeof loadManifest>>);
	get.mockClear();
});
afterEach(() => vi.clearAllMocks());
it('maps a cross-chunk compressed byte range without reading preceding or following chunks', async () => {
	const response = (await serveLargeNarRange(
		request(`bytes=${chunkSize - 3}-${chunkSize + 3}`),
		env,
		ctx,
		'hash',
		7
	))!;
	expect(response.status).toBe(206);
	expect(response.headers.get('Content-Range')).toBe(
		`bytes ${chunkSize - 3}-${chunkSize + 3}/${size}`
	);
	expect(response.headers.get('Content-Length')).toBe('7');
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array([1, 1, 1, 2, 2, 2, 2])
	);
	await Promise.all(tasks);
	expect(get.mock.calls).toEqual([
		['1', { range: { offset: chunkSize - 3, length: 3 } }],
		['2', { range: { offset: 0, length: 4 } }]
	]);
	expect(loadManifest).toHaveBeenCalledWith(env, ctx, 'hash', 7);
	expect(chargeBackendRead).toHaveBeenCalledOnce();
});
it.each([`bytes=${size - 7}-`, 'bytes=-7', `bytes=${size - 7}-${size + 100}`])(
	'supports a suffix/open-ended/clamped range: %s',
	async (range) => {
		const response = (await serveLargeNarRange(request(range), env, ctx, 'hash'))!;
		expect(response.status).toBe(206);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(7).fill(3));
		await Promise.all(tasks);
		expect(get).toHaveBeenCalledExactlyOnceWith('3', {
			range: { offset: chunkSize - 7, length: 7 }
		});
	}
);
it.each([`bytes=${size}-`, 'bytes=-0', 'bytes=10-9', 'bytes=999999999999999999999999-'])(
	'rejects an unsatisfiable range without reading storage: %s',
	async (range) => {
		const response = (await serveLargeNarRange(request(range), env, ctx, 'hash'))!;
		expect(response.status).toBe(416);
		expect(response.headers.get('Content-Range')).toBe(`bytes */${size}`);
		expect(get).not.toHaveBeenCalled();
	}
);
it.each(['items=1-3', 'bytes=1-3,8-10', 'bytes=-', 'bytes=not-a-range'])(
	'leaves unsupported syntax to the full-response path: %s',
	async (range) => {
		expect(await serveLargeNarRange(request(range), env, ctx, 'hash')).toBeUndefined();
		expect(loadManifest).not.toHaveBeenCalled();
	}
);
it('preserves cacheable edge ranges and If-Range/HEAD semantics', async () => {
	vi.mocked(loadManifest).mockResolvedValue({
		nar: { num_chunks: 1 },
		chunks: [{ file_size: CACHEABLE_NAR_BYTES }]
	} as Awaited<ReturnType<typeof loadManifest>>);
	expect(await serveLargeNarRange(request('bytes=0-9'), env, ctx, 'hash')).toBeUndefined();
	expect(
		await serveLargeNarRange(request('bytes=0-9', { 'If-Range': '"old"' }), env, ctx, 'hash')
	).toBeUndefined();
	expect(
		await serveLargeNarRange(
			new Request('https://cache.test/nar', { method: 'HEAD', headers: { Range: 'bytes=0-9' } }),
			env,
			ctx,
			'hash'
		)
	).toBeUndefined();
	expect(get).not.toHaveBeenCalled();
});
it('fails a missing stored chunk without silently returning a short successful body', async () => {
	get.mockResolvedValueOnce(null as never);
	const response = (await serveLargeNarRange(request('bytes=-7'), env, ctx, 'hash'))!;
	await expect(response.arrayBuffer()).rejects.toThrow('Range chunk missing');
	await Promise.all(tasks);
});
