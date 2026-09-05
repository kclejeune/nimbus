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

/** Count bytes while reading: Content-Length alone cannot bound streamed input. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
	if (Number(request.headers.get('content-length')) > maxBytes) {
		await request.body?.cancel().catch(() => {});
		throw new RequestBodyError(413, 'Request body too large');
	}
	if (!request.body) throw new RequestBodyError(400, 'Missing JSON body');
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
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
	try {
		return JSON.parse(text);
	} catch {
		throw new RequestBodyError(400, 'Invalid JSON');
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
