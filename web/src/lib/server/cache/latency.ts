import { AsyncLocalStorage } from 'node:async_hooks';
import { readSampleRate } from './metrics';

type Stage = 'auth' | 'candidates' | 'store' | 'upstream' | 'admission' | 'd1' | 'r2';
interface Sample {
	timings: Partial<Record<Stage, number>>;
	d1: number;
	rowsRead: number;
	rowsWritten: number;
	r2: number;
	retries: number;
}
const current = new AsyncLocalStorage<Sample>();

export async function measure<T>(stage: Stage, op: () => Promise<T>): Promise<T> {
	const state = current.getStore();
	if (!state) return op();
	const start = performance.now();
	try {
		return await op();
	} finally {
		state.timings[stage] = (state.timings[stage] ?? 0) + performance.now() - start;
	}
}
export function countRetry(): void {
	const s = current.getStore();
	if (s) s.retries++;
}
export function countR2(): void {
	const s = current.getStore();
	if (s) s.r2++;
}
export function countD1(
	statements: number,
	results?: { meta?: { rows_read?: number; rows_written?: number } }[]
): void {
	const s = current.getStore();
	if (!s) return;
	s.d1 += statements;
	for (const r of results ?? []) {
		s.rowsRead += r.meta?.rows_read ?? 0;
		s.rowsWritten += r.meta?.rows_written ?? 0;
	}
}

export function routeTemplate(request: Request): string {
	const parts = new URL(request.url).pathname.split('/').filter(Boolean);
	let path: string;
	if (parts[0] === '_meta') path = '/_meta/:kind/:hash';
	else if (parts[0] === '_touch') path = '/_touch/:cache/:hash';
	else if (parts[0] === '_manifest') path = '/_manifest/:cache/:hash';
	else if (parts[0] === '_chunk') path = '/_chunk/:key';
	else if (parts[0]?.startsWith('_nar')) path = '/_nar/:hash';
	else if (parts[0] === 'nar') path = '/nar/:file';
	else if (parts[1] === 'nar') path = '/:cache/nar/:file';
	else if (parts.at(-1)?.endsWith('.narinfo'))
		path = parts.length === 1 ? '/:hash.narinfo' : '/:cache/:hash.narinfo';
	else if (parts[0] === '_api' && parts[1] === 'v1') {
		const known = [
			'upload-path',
			'get-missing-paths',
			'gc',
			'tokens',
			'caches',
			'cache-config',
			'pin',
			'gc-root',
			'auth-config',
			'cli'
		];
		const operation = known.includes(parts[2]) ? parts[2] : ':operation';
		path = `/_api/v1/${operation}`;
		if (operation === 'upload-path' && parts[3] === 'chunks')
			path += parts[4] === 'complete' ? '/chunks/complete' : parts[4] ? '/chunks/:hash' : '/chunks';
		else if (parts.length > 3) path += '/:id';
	} else
		path =
			parts.length === 0
				? '/'
				: parts.at(-1) === 'nix-cache-info'
					? '/:cache/nix-cache-info'
					: '/:other';
	return `${request.method} ${path}`;
}

/** Header latency only: body-transfer duration belongs to client/download metrics. */
export async function observeRequest(
	request: Request,
	env: App.Platform['env'],
	layer: 'gateway' | 'store',
	op: () => Promise<Response>
): Promise<Response> {
	const divisor = readSampleRate(env);
	if (Math.random() * divisor >= 1) return op();
	const sample: Sample = { timings: {}, d1: 0, rowsRead: 0, rowsWritten: 0, r2: 0, retries: 0 };
	return current.run(sample, async () => {
		const start = performance.now();
		const response = await op();
		const route = routeTemplate(request);
		const elapsed = performance.now() - start;
		const edge = response.headers.get('CF-Cache-Status') ?? 'NONE';
		const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? 'unknown';
		try {
			env.CACHE_METRICS?.writeDataPoint({
				blobs: ['latency', layer, route, edge, colo, String(response.status)],
				doubles: [
					divisor,
					elapsed,
					sample.d1,
					sample.rowsRead,
					sample.rowsWritten,
					sample.r2,
					sample.retries,
					// -1 marks an unknown size (a streamed body without
					// Content-Length) so it is not averaged in as an empty response.
					response.headers.has('Content-Length')
						? Number(response.headers.get('Content-Length'))
						: -1,
					sample.timings.auth ?? 0,
					sample.timings.candidates ?? 0,
					sample.timings.store ?? 0,
					sample.timings.upstream ?? 0,
					sample.timings.admission ?? 0,
					sample.timings.d1 ?? 0,
					sample.timings.r2 ?? 0
				],
				indexes: ['_latency']
			});
			console.log(
				JSON.stringify({
					event: 'nimbus.latency',
					route,
					layer,
					status: response.status,
					edge,
					colo,
					headerMs: elapsed,
					...sample
				})
			);
		} catch {
			/* Observability never changes the response. */
		}
		return response;
	});
}
