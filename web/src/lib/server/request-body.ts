import { errorResponse } from './attic/http';

export class RequestBodyError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}

	response(): Response {
		return errorResponse(this.status, this.message);
	}
}

/** A sender that stops mid-body must not hold an upload slot; 30 s idle is
 * generous for any live TCP stream. */
export const BODY_IDLE_TIMEOUT_MS = 30_000;
/** Absolute backstop against a deliberate trickle. Matches the Go client's
 * request timeout: a legitimate 100 MB PUT on a slow uplink takes far longer
 * than the five minutes this first shipped with. */
export const BODY_MAX_DURATION_MS = 30 * 60_000;

export const bodyDeadline = (): number => Date.now() + BODY_MAX_DURATION_MS;

/** Both idle and absolute deadlines matter: a trickle must not hold admission forever. */
export async function readWithTimeout<T>(
	reader: ReadableStreamDefaultReader<T>,
	deadline: number
): Promise<ReadableStreamReadResult<T>> {
	const timeoutMs = Math.min(BODY_IDLE_TIMEOUT_MS, deadline - Date.now());
	if (timeoutMs <= 0) {
		void reader.cancel().catch(() => {});
		throw new RequestBodyError(408, 'Request body deadline exceeded');
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new RequestBodyError(408, 'Request body stalled'));
					void reader.cancel().catch(() => {});
				}, timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Count bytes while reading: Content-Length alone cannot bound streamed input.
 * With `optional`, a missing or whitespace-only body reads as null instead of
 * a 400. */
export async function readJson(
	request: Request,
	maxBytes: number,
	{ optional = false }: { optional?: boolean } = {}
): Promise<unknown> {
	if (Number(request.headers.get('content-length')) > maxBytes) {
		await request.body?.cancel().catch(() => {});
		throw new RequestBodyError(413, 'Request body too large');
	}
	if (!request.body) {
		if (optional) return null;
		throw new RequestBodyError(400, 'Missing JSON body');
	}
	const reader = request.body.getReader();
	const deadline = bodyDeadline();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		while (true) {
			const { value, done } = await readWithTimeout(reader, deadline);
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new RequestBodyError(413, 'Request body too large');
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	if (optional && text.trim() === '') return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new RequestBodyError(400, 'Invalid JSON');
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Control-plane JSON body limits, generous next to any valid request. */
export const JSON_LIMITS = {
	rename: 4 * 1024,
	gcRoot: 16 * 1024,
	cacheConfig: 32 * 1024,
	token: 16 * 1024
} as const;

export function assertIntInRange(field: string, value: number, min: number, max: number): void {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new RequestBodyError(400, `${field} must be an integer in ${min}..${max}`);
	}
}

export function assertMaxLength(
	field: string,
	value: string | null | undefined,
	max: number
): void {
	if (value != null && value.length > max) {
		throw new RequestBodyError(400, `${field} exceeds ${max} characters`);
	}
}
