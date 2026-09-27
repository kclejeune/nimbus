import { AsyncLocalStorage } from 'node:async_hooks';
import type { D1Result } from '@cloudflare/workers-types';
import { readSampleRate } from './metrics';

type Stage =
	| 'auth'
	| 'candidates'
	| 'store'
	| 'upstream'
	| 'admission'
	| 'd1'
	| 'r2'
	| 'manifest'
	| 'candidateLoopback'
	| 'candidateVisibility'
	| 'candidateConfirm'
	| 'candidateRefresh'
	| 'proxyKeypair'
	| 'upstreamRedirect'
	| 'wasmWait'
	| 'wasmHold'
	| 'cdcProof'
	| 'cdcLock'
	| 'cdcRead'
	| 'cdcVerify'
	| 'cdcPublish'
	| 'chunkRelease';
interface Sample {
	timings: Partial<Record<Stage, number>>;
	d1: number;
	rowsRead: number;
	rowsWritten: number;
	/** Statements D1 reports as served by the primary (Sessions API meta).
	 * Reads issued through readSession should land on a replica; a nonzero
	 * count on a read route is the signal that they did not. */
	d1Primary: number;
	/** Region of the last D1 result, for the served-by breakdown. */
	d1Region: string | null;
	r2: number;
	retries: number;
	loopbackFallbacks: number;
	d1SqlMs: number;
	d1PrimarySqlMs: number;
	d1Attempts: number;
	candidate?: { source: string; listed: boolean };
	upload?: { chunks: number; rawBytes: number; compressedBytes?: number };
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
/** Stream pumps retain this counter after the header sample has been emitted. */
export function countLoopbackFallback(): void {
	const s = current.getStore();
	if (s) {
		s.loopbackFallbacks++;
		s.retries++;
	}
}
export function candidateMetadata(source: string, listed: boolean): void {
	const s = current.getStore();
	if (s) s.candidate = { source, listed };
}
export function uploadShape(chunks: number, rawBytes: number, compressedBytes?: number): void {
	const s = current.getStore();
	if (s) s.upload = { chunks, rawBytes, compressedBytes };
}

/** A separate completion event: body work can outlive observeRequest's header sample. */
export function streamObservation(): (status: 'ok' | 'error', chunks: number) => void {
	const sample = current.getStore();
	const started = performance.now();
	const retries = sample?.retries ?? 0;
	const fallbacks = sample?.loopbackFallbacks ?? 0;
	return (status, chunks) => {
		if (!sample) return;
		console.log(
			JSON.stringify({
				event: 'nimbus.stream',
				route: 'GET /_nar/:hash',
				layer: 'store',
				status,
				chunks,
				ms: performance.now() - started,
				retries: sample.retries - retries,
				loopbackFallbacks: sample.loopbackFallbacks - fallbacks
			})
		);
	};
}

export function countRetry(): void {
	const s = current.getStore();
	if (s) s.retries++;
}
export function countR2(): void {
	const s = current.getStore();
	if (s) s.r2++;
}
export function countD1(statements: number, results?: Pick<D1Result, 'meta'>[]): void {
	const s = current.getStore();
	if (!s) return;
	s.d1 += statements;
	for (const r of results ?? []) {
		s.rowsRead += r.meta?.rows_read ?? 0;
		s.rowsWritten += r.meta?.rows_written ?? 0;
		const sqlMs = r.meta?.timings?.sql_duration_ms ?? 0;
		s.d1SqlMs += sqlMs;
		s.d1Attempts += r.meta?.total_attempts ?? 1;
		if (r.meta?.served_by_primary) {
			s.d1Primary++;
			s.d1PrimarySqlMs += sqlMs;
		}
		if (r.meta?.served_by_region) s.d1Region = r.meta.served_by_region;
	}
}

export function routeTemplate(request: Request): string {
	const parts = new URL(request.url).pathname.split('/').filter(Boolean);
	let path: string;
	if (parts[0] === '_upstream_nar') path = '/_upstream_nar/:scope/:file';
	else if (parts[0] === '_meta') path = '/_meta/:kind/:hash';
	else if (parts[0] === '_touch') path = '/_touch/:cache/:hash';
	else if (parts[0] === '_manifest') path = '/_manifest/:cache/:hash';
	else if (parts[0] === '_chunk') path = '/_chunk/:key';
	else if (parts[0]?.startsWith('_nar')) path = '/_nar/:hash';
	else if (parts[0] === 'nar') path = '/nar/:file';
	else if (parts[1] === 'nar') path = '/:cache/nar/:file';
	else if (parts[0] === '_proxy_upstream') path = '/_proxy_upstream/:hash.narinfo';
	else if (parts[0] === '_proxy') path = '/_proxy/:cache/:hash.narinfo';
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
	op: () => Promise<Response>,
	route = routeTemplate(request)
): Promise<Response> {
	const path = route.slice(route.indexOf(' ') + 1);
	// Capture every upload, including admission refusals and rare CDC completions.
	const divisor =
		layer === 'gateway' &&
		(path.startsWith('/_api/v1/upload-path') || path === '/_api/v1/get-missing-paths')
			? 1
			: readSampleRate(env);
	if (Math.random() * divisor >= 1) return op();
	const sample: Sample = {
		timings: {},
		d1: 0,
		rowsRead: 0,
		rowsWritten: 0,
		d1Primary: 0,
		d1Region: null,
		r2: 0,
		retries: 0,
		loopbackFallbacks: 0,
		d1SqlMs: 0,
		d1PrimarySqlMs: 0,
		d1Attempts: 0
	};
	return current.run(sample, async () => {
		const start = performance.now();
		const response = await op();
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
					sample.timings.r2 ?? 0,
					sample.d1Primary,
					sample.timings.manifest ?? 0,
					// Append only: double18..20. Additional stage detail lives in logs.
					sample.loopbackFallbacks,
					sample.d1SqlMs,
					sample.d1PrimarySqlMs
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
