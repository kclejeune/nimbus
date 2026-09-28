import type { D1Database } from '@cloudflare/workers-types';
import * as db from './db';
import { AdmissionError, CLIENT_IP_HEADER, clientKey, requireBudget } from './admission';
import type { ExecutionContext } from './platform';
import { stripSha256 } from '../attic/nix-base32';
import { findCacheCached } from './cache-lookup';
import { AsyncMemo } from './async-memo';
import { countLoopbackFallback, measure, candidateMetadata } from './latency';

export const CANDIDATES_TAG = 'candidates';
export const candidateTag = (kind: string, hash: string) =>
	`candidate:${kind}:${stripSha256(hash)}`;

/** Every store miss about to touch D1/R2 is charged per client (the gateway
 * stamps the IP; a limiter key is not a response variation, so CachedStore
 * stays caller-independent), and not at all for internal loopbacks that carry
 * no IP — prefetch has its own budget, and a constant colo-wide key here made
 * one CI fleet's cold closure everyone's 503. */
export function chargeBackendRead(env: App.Platform['env'], request: Request): Promise<void> {
	return chargeClientRead(env, request.headers.get(CLIENT_IP_HEADER));
}

/** Charge one D1 read to a client's backend-read budget; free without an IP. */
async function chargeClientRead(env: App.Platform['env'], clientIp: string | null): Promise<void> {
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

// Candidate metadata is invalidated actively (uploads, GC and visibility
// changes all purge its tags), but a refill right after a purge reads a
// replica that may not have the mutation yet, so the TTL is what bounds that
// race. Membership rarely changes and a stale positive fails safe (the
// store 404s a reaped object; visibility is re-read below), so it can live
// an hour — at 30 s prod paid a candidate D1 read per unified-endpoint
// request, half of all D1 reads. An empty list stays short: a lagging refill
// after an upload would otherwise hide the fresh path for the whole TTL.
// It is still served stale while it refreshes, for as long as a non-empty
// list: upstream-only paths are re-polled by every CI run, often hours
// apart, and past the stale window the edge refills them inline — that
// synchronous refill was the root-read latency tail. A stale empty entry
// is safe to serve for that long because it never decides a miss:
// Candidates.confirmEmpty re-reads it before an upstream miss or failure
// becomes the answer. stale-if-error=0 overrides the platform's indefinite
// default.
// The NAR manifest stays must-revalidate — a re-upload after GC changes its
// chunk keys.
const LONG_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
const EMPTY_MAX_AGE_MS = 30_000;
const EMPTY_CACHE_CONTROL = `public, max-age=${EMPTY_MAX_AGE_MS / 1000}, stale-while-revalidate=86400, stale-if-error=0`;
const SHORT_CACHE_CONTROL = 'public, max-age=30, must-revalidate';

// When a candidate list was read from D1. The edge keeps it with the entry,
// so the gateway judges staleness from the fill itself rather than from how
// the caching layer labels a stale-while-revalidate hit in CF-Cache-Status.
const FILLED_AT_HEADER = 'X-Nimbus-Filled-At';

/** Internal metadata: edge-cached, evicted by tag on change. */
function cachedJson(body: unknown, tag: string, cacheControl: string): Response {
	return new Response(JSON.stringify(body), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': cacheControl,
			'Cache-Tag': `${CANDIDATES_TAG},${tag}`
		}
	});
}

/** Whether an entry is past the empty max-age. A missing or malformed stamp
 * counts as stale: confirming costs one memoized replica read, while wrongly
 * trusting it can hide a fresh upload behind a 404. */
function pastEmptyMaxAge(headers: Headers): boolean {
	const filledAt = Number(headers.get(FILLED_AT_HEADER));
	return !(filledAt > 0) || Date.now() - filledAt >= EMPTY_MAX_AGE_MS;
}

/** Release a loopback RPC result whose body will not be read: an unconsumed
 * body keeps the RPC result alive until GC ("RPC result was not disposed"). */
export async function disposeLoopback(response: Response | undefined): Promise<void> {
	await response?.body?.cancel().catch(() => {});
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
	countLoopbackFallback();
	console.warn(`store loopback returned 502; serving uncached: ${new URL(request.url).pathname}`);
	await disposeLoopback(response);
	return direct();
}

/** The JSON body of an internal loopback response. Any non-2xx is a transient
 * refusal, retried no sooner than the store asked (a budget refusal's minute). */
export async function internalJson<T>(response: Response, unavailable: string): Promise<T> {
	if (!response.ok) {
		await response.body?.cancel();
		const retryAfter = Number(response.headers.get('Retry-After'));
		throw new AdmissionError(unavailable, retryAfter > 0 ? retryAfter : 2);
	}
	return response.json();
}

/** How much longer a loopback response is fresh: its max-age less the Age an
 * edge hit carries. Zero for no-store, a missing max-age, or a stale entry
 * served under stale-while-revalidate / stale-if-error. */
export function remainingFreshMs(headers: Headers): number {
	const cacheControl = headers.get('Cache-Control') ?? '';
	const maxAge = /(?:^|[\s,])max-age=(\d+)/.exec(cacheControl);
	if (!maxAge || /no-store/.test(cacheControl)) return 0;
	const age = Number(headers.get('Age')) || 0;
	return Math.max(0, Number(maxAge[1]) - age) * 1000;
}

/** Never exposed by the gateway: candidate rows contain private cache names.
 * Charges admission itself so the uncached fallback in loadCandidates pays
 * the same as a store miss. */
export async function serveCandidates(
	request: Request,
	env: App.Platform['env'],
	kind: 'nar' | 'path',
	hash: string
): Promise<Response> {
	await chargeBackendRead(env, request);
	const rows = await readCandidateRows(db.readSession(env.ATTIC_DB), kind, hash);
	const response = cachedJson(
		rows,
		candidateTag(kind, hash),
		rows.length > 0 ? LONG_CACHE_CONTROL : EMPTY_CACHE_CONTROL
	);
	response.headers.set(FILLED_AT_HEADER, String(Date.now()));
	return response;
}

export interface Candidates {
	/** Listed caches that still exist, with current visibility. */
	rows: db.LiveCacheRow[];
	/** Whether the edge entry listed any cache at all — a non-empty entry is
	 * the long-lived kind whose staleness confirmCandidates guards, even when
	 * every listed cache has since been deleted and `rows` is empty. */
	listed: boolean;
	/** Re-read an empty entry served past its max-age before a miss becomes
	 * final: it can predate an upload by the stale window, so it must not end
	 * in a 404 or an absence record unconfirmed. Null when there is nothing
	 * to confirm (a listed or fresh empty entry). */
	confirmEmpty(): Promise<db.LiveCacheRow[] | null>;
}

// No per-isolate memo in front of the loopback: repeats of one hash arrive
// minutes apart and from other colos, so a five-second positive memo hit
// 1 of 942 sampled lookups in prod (2026-09-27); the edge entry is the cache.
export function invalidateCandidates(kind: 'nar' | 'path', hash: string): void {
	const key = `${kind}:${stripSha256(hash)}`;
	confirmedCandidates.clear(key);
	refreshedEmpty.clear(key);
}

export async function loadCandidates(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	request: Request,
	kind: 'nar' | 'path',
	hash: string
): Promise<Candidates> {
	const canonical = stripSha256(hash);
	if (canonical.length > 256) return { rows: [], listed: false, confirmEmpty: async () => null };
	const internal = internalRequest(
		env,
		`/_meta/${kind}/${encodeURIComponent(canonical)}`,
		request.headers.get('CF-Connecting-IP')
	);
	const response = await measure('candidateLoopback', () =>
		viaStore(ctx, internal, () => serveCandidates(internal, env, kind, canonical))
	);
	const rows = await internalJson<db.LiveCacheRow[]>(
		response,
		'Candidate resolution temporarily unavailable'
	);
	const stale = rows.length === 0 && pastEmptyMaxAge(response.headers);
	candidateMetadata(response.headers.get('CF-Cache-Status') ?? 'NONE', rows.length > 0);
	return {
		rows: await measure('candidateVisibility', () => withCurrentVisibility(env, rows)),
		listed: rows.length > 0,
		confirmEmpty: async () =>
			stale ? refreshEmptyCandidates(env, ctx, request, kind, canonical) : null
	};
}

// Candidate lists confirmed against the primary. A positive edge entry can
// outlive a membership change for its whole TTL when its refill raced
// replication; the cases where that hides something — the list names
// caches but none is readable by this caller, a cache is not listed as
// holding a NAR it just received, a winner no longer holds the object — are
// re-read here with a consistency guarantee. Memoized per isolate so a burst
// of such requests costs the primary one read per hash per minute, and a
// confirmed change evicts the stale edge entry.
const CONFIRMED_TTL_MS = 60_000;
const confirmedCandidates = new AsyncMemo<db.LiveCacheRow[]>(CONFIRMED_TTL_MS, 10_000);

export function clearCandidateMemos(): void {
	confirmedCandidates.clear();
	refreshedEmpty.clear();
}

function readCandidateRows(
	session: D1Database,
	kind: 'nar' | 'path',
	canonical: string
): Promise<db.LiveCacheRow[]> {
	return kind === 'nar'
		? db.cachesWithNarHash(session, [`sha256:${canonical}`, canonical])
		: db.cachesWithStorePathHash(session, canonical);
}

/** Re-read a candidate list, charged to the requesting client, and evict
 * the edge entry when the membership differs from what it served. */
async function rereadCandidates(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	request: Request,
	session: D1Database,
	kind: 'nar' | 'path',
	canonical: string,
	cached: db.LiveCacheRow[]
): Promise<db.LiveCacheRow[]> {
	await chargeClientRead(env, request.headers.get('CF-Connecting-IP'));
	const rows = await readCandidateRows(session, kind, canonical);
	const ids = (list: db.LiveCacheRow[]) =>
		list
			.map((r) => r.id)
			.sort()
			.join(',');
	const store = ctx?.exports?.CachedStore;
	if (store && ids(rows) !== ids(cached)) {
		ctx.waitUntil(store.enqueuePurgeTags([candidateTag(kind, canonical)]).catch(() => {}));
	}
	return rows;
}

export async function confirmCandidates(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	request: Request,
	kind: 'nar' | 'path',
	hash: string,
	cached: db.LiveCacheRow[]
): Promise<db.LiveCacheRow[]> {
	const canonical = stripSha256(hash);
	const key = `${kind}:${canonical}`;
	const rows = await measure('candidateConfirm', () =>
		confirmedCandidates.get(key, () =>
			rereadCandidates(env, ctx, request, db.primarySession(env.ATTIC_DB), kind, canonical, cached)
		)
	);
	return measure('candidateVisibility', () => withCurrentVisibility(env, rows));
}

// Stale empty entries re-read on a replica: the same read, budget and
// consistency the synchronous refill of an expired entry used to have. An
// upload committed within the replica's lag can still be missed — and the
// root narinfo route then records the miss as absent for its TTL — exactly
// as a refill right after the upload's purge can miss it (see the
// Cache-Control note above). Confirming on the primary instead would close
// that window only here, at a primary read whenever the upstream lookup
// misses or fails; upstream hits never reach this. An empty result is
// memoized for the empty max-age, so upstream-only lookups of one hash cost
// an isolate at most one read per window, as the refill did. A found list
// is kept briefly too, so requests racing the edge purge it enqueued reuse
// it instead of re-reading and re-purging.
const REFRESHED_FOUND_MS = 5_000;
const refreshedEmpty = new AsyncMemo<db.LiveCacheRow[]>(EMPTY_MAX_AGE_MS, 10_000);

async function refreshEmptyCandidates(
	env: App.Platform['env'],
	ctx: ExecutionContext | undefined,
	request: Request,
	kind: 'nar' | 'path',
	canonical: string
): Promise<db.LiveCacheRow[]> {
	const rows = await measure('candidateRefresh', () =>
		refreshedEmpty.get(
			`${kind}:${canonical}`,
			() => rereadCandidates(env, ctx, request, db.readSession(env.ATTIC_DB), kind, canonical, []),
			(rows) => (rows.length ? REFRESHED_FOUND_MS : EMPTY_MAX_AGE_MS)
		)
	);
	return measure('candidateVisibility', () => withCurrentVisibility(env, rows));
}

/**
 * Candidate rows are authorization input (is_public decides anonymous
 * reads), and their edge entry outlives a visibility change whenever the
 * refill raced replication. Take visibility from the cache row instead —
 * the per-isolate memo the per-cache routes already trust, bounded by its
 * own short TTL — and drop candidates whose cache is gone or was recreated
 * under the same name.
 */
async function withCurrentVisibility(
	env: App.Platform['env'],
	rows: db.LiveCacheRow[]
): Promise<db.LiveCacheRow[]> {
	const current = await Promise.all(
		rows.map(async (row) => {
			const cache = await findCacheCached(env.ATTIC_DB, row.name);
			return cache && cache.id === row.id ? { ...row, is_public: cache.is_public } : null;
		})
	);
	return current.filter((row) => row !== null);
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
	return cachedJson(found, candidateTag('nar', hash), SHORT_CACHE_CONTROL);
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
