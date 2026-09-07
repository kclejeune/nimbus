import * as db from './db';
import { AdmissionError, CLIENT_IP_HEADER, clientKey, requireBudget } from './admission';
import type { ExecutionContext } from './platform';
import { stripSha256 } from '../attic/nix-base32';

export const CANDIDATES_TAG = 'candidates';
export const candidateTag = (kind: string, hash: string) =>
	`candidate:${kind}:${stripSha256(hash)}`;

/** Every store miss about to touch D1/R2 is charged per client (the gateway
 * stamps the IP; a limiter key is not a response variation, so CachedStore
 * stays caller-independent), and not at all for internal loopbacks that carry
 * no IP — prefetch has its own budget, and a constant colo-wide key here made
 * one CI fleet's cold closure everyone's 503. */
export async function chargeBackendRead(env: App.Platform['env'], request: Request): Promise<void> {
	const clientIp = request.headers.get(CLIENT_IP_HEADER);
	if (clientIp) await requireBudget(env.BACKEND_READ_LIMITER, clientKey('backend-read', clientIp));
}

/** Stamp (or clear) the client IP the store charges its backend-read budget
 * to. Overwritten, never passed through: a client must not pick whose
 * budget it spends, and internal loopbacks that carry no IP are free. */
export function stampClientIp(headers: Headers, clientIp: string | null): void {
	if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
	else headers.delete(CLIENT_IP_HEADER);
}

/** A request to an internal store route. The origin comes from
 * CACHE_BASE_URL, never the incoming request: it is part of the edge key,
 * and dev proxies rewrite the Host. */
export function internalRequest(
	env: App.Platform['env'],
	path: string,
	clientIp: string | null = null
): Request {
	const request = new Request(new URL(path, env.CACHE_BASE_URL || 'https://cache.internal'));
	stampClientIp(request.headers, clientIp);
	return request;
}

/** Candidate metadata: briefly edge-cached, evicted by tag on change. */
function cachedJson(body: unknown, tag: string): Response {
	return new Response(JSON.stringify(body), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=30, must-revalidate',
			'Cache-Tag': `${CANDIDATES_TAG},${tag}`
		}
	});
}

/**
 * Serve a read through the CachedStore loopback when it is available, else
 * directly. The Workers Caching pipeline intermittently mints an empty 502
 * without invoking CachedStore; read-path code never emits 502, so that
 * status alone identifies a caching-layer failure and the request is served
 * uncached instead of passing it through. Reusing `request` is safe: GET,
 * no body to disturb.
 */
export async function viaStore(
	ctx: ExecutionContext | undefined,
	request: Request,
	direct: () => Promise<Response>
): Promise<Response> {
	const store = ctx?.exports?.CachedStore;
	if (!store) return direct();
	const response = await store.fetch(request);
	if (response.status !== 502) return response;
	console.warn(`store loopback returned 502; serving uncached: ${new URL(request.url).pathname}`);
	await response.body?.cancel().catch(() => {});
	return direct();
}

/** The JSON body of an internal metadata response, or the transient error
 * clients see when the metadata route itself failed. */
async function internalJson<T>(response: Response, unavailable: string): Promise<T> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new AdmissionError(unavailable, 2);
	}
	return response.json();
}

/** Never exposed by the gateway: candidate rows contain private cache names.
 * Charges admission itself so the uncached fallback in loadCandidates pays
 * the same as a store miss. */
export async function serveCandidates(
	request: Request,
	env: App.Platform['env'],
	kind: string,
	hash: string
): Promise<Response> {
	await chargeBackendRead(env, request);
	const session = db.readSession(env.ATTIC_DB);
	const rows =
		kind === 'nar'
			? await db.cachesWithNarHash(session, [`sha256:${hash}`, hash])
			: await db.cachesWithStorePathHash(session, hash);
	return cachedJson(rows, candidateTag(kind, hash));
}

export async function loadCandidates(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	request: Request,
	kind: 'nar' | 'path',
	hash: string
): Promise<db.LiveCacheRow[]> {
	const canonical = stripSha256(hash);
	if (canonical.length > 256) return [];
	const internal = internalRequest(
		env,
		`/_meta/${kind}/${encodeURIComponent(canonical)}`,
		request.headers.get('CF-Connecting-IP')
	);
	return internalJson(
		await viaStore(ctx, internal, () => serveCandidates(internal, env, kind, canonical)),
		'Candidate resolution temporarily unavailable'
	);
}

export async function serveTouch(
	env: App.Platform['env'],
	cacheId: number,
	hash: string
): Promise<Response> {
	await db.touchObjectsForNarHash(env.ATTIC_DB, cacheId, hash);
	return new Response('ok', {
		headers: {
			'Cache-Control': `public, max-age=${db.TOUCH_GRANULARITY_MS / 1000}, must-revalidate`
		}
	});
}

export async function touchViaStore(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	cacheId: number,
	hash: string
): Promise<void> {
	const internal = internalRequest(env, `/_touch/${cacheId}/${encodeURIComponent(hash)}`);
	const response = await viaStore(ctx, internal, () => serveTouch(env, cacheId, hash));
	await response.body?.cancel();
	if (!response.ok) throw new Error(`Retention touch failed: ${response.status}`);
}

export async function serveManifest(
	env: App.Platform['env'],
	scope: string,
	hash: string
): Promise<Response> {
	const found = await db.findNarWithChunks(
		db.readSession(env.ATTIC_DB),
		[`sha256:${hash}`, hash],
		scope === 'public' ? undefined : Number(scope)
	);
	return cachedJson(found, candidateTag('nar', hash));
}

export async function loadManifest(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	hash: string,
	cacheId?: number
): Promise<Awaited<ReturnType<typeof db.findNarWithChunks>>> {
	const scope = cacheId === undefined ? 'public' : String(cacheId);
	const request = internalRequest(env, `/_manifest/${scope}/${encodeURIComponent(hash)}`);
	return internalJson(
		await viaStore(ctx, request, () => serveManifest(env, scope, hash)),
		'NAR manifest temporarily unavailable'
	);
}
