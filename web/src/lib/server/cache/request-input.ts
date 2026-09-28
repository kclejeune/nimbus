import { isRecord, readJson, RequestBodyError } from '../request-body';

// Cap before deduplication to bound parsing and DB work. The stock attic
// client sends a whole closure in one request, so this sits well above real
// closures; the nimbus CLI batches at 10k.
export const MAX_MISSING_PATHS = 50_000;

export async function readMissingPaths(request: Request) {
	// ~35 bytes of JSON per hash.
	const body = await readJson(request, 2 * 1024 * 1024);
	if (
		!isRecord(body) ||
		typeof body.cache !== 'string' ||
		!body.cache ||
		!Array.isArray(body.store_path_hashes) ||
		(body.ignore_upstream_cache_filter !== undefined &&
			typeof body.ignore_upstream_cache_filter !== 'boolean')
	) {
		throw new RequestBodyError(400, 'Invalid cache or store_path_hashes');
	}
	if (body.store_path_hashes.length > MAX_MISSING_PATHS) {
		throw new RequestBodyError(413, `At most ${MAX_MISSING_PATHS} store paths per request`);
	}
	const hashes: string[] = [];
	for (const hash of body.store_path_hashes) {
		if (typeof hash !== 'string' || !/^[0123456789abcdfghijklmnpqrsvwxyz]{32}$/.test(hash)) {
			throw new RequestBodyError(400, 'Invalid store path hash');
		}
		hashes.push(hash);
	}
	return {
		cache: body.cache,
		hashes: [...new Set(hashes)],
		ignoreUpstream: body.ignore_upstream_cache_filter === true
	};
}

export async function readDeviceCode(request: Request): Promise<string> {
	const body = await readJson(request, 1024);
	if (
		!isRecord(body) ||
		typeof body.device_code !== 'string' ||
		!/^[a-f0-9]{64}$/.test(body.device_code)
	) {
		throw new RequestBodyError(400, 'Invalid device_code');
	}
	return body.device_code;
}
