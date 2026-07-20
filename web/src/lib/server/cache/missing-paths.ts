// POST /_api/v1/get-missing-paths, ported from the Rust worker and extended
// with upstream filtering: paths already fetchable from an enabled upstream
// binary cache are not reported as missing, so clients never push them here.
// Verdicts are cached in upstream_check (absent = rechecked daily; present =
// lazily re-probed after the upstream's TTL, since upstreams like cachix GC).
//
// Upstreams live in the instance-level registry (the `upstream` table):
// trust — URL, public key, TTL — is admin-managed and unique per URL, so a
// same-URL/different-key conflict is unrepresentable. Caches subscribe with
// a per-cache mode (cache_upstream), inheriting the registry default when no
// override row exists; enforced entries participate at least as redirect.
//
// An upstream may carry a public key; when it does, an entry only counts as
// present if its narinfo carries a valid signature from that key.

import { parseNarInfo, parsedNarInfoSignatureValid, type ParsedNarInfo } from '../attic/narinfo';
import { dbAll, dbBatch, readSession } from './db';
import { recordGuard } from './metrics';
import { type ExecutionContext } from './platform';
import { TtlMemo } from './ttl-memo';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];

/** One resolved (registry × subscription) upstream, as the read/filter paths
 * consume it. */
export interface Upstream {
	/** Registry row id — the key verdicts are recorded under. */
	id: number;
	url: string;
	/** Nix public key (`name:base64`); non-null enforces signature checks. */
	publicKey: string | null;
	/** Seconds a "present" verdict (and its edge-cached passthrough) lives
	 * before the CDN/lazy re-probe; null = DEFAULT_UPSTREAM_TTL_SECS. Give
	 * stable archives (cache.nixos.org never GCs) a long TTL and volatile
	 * sources (cachix GCs) a short one. Query order is the registry's
	 * admin-controlled `position`, not the TTL. */
	ttl: number | null;
	/** persist = pull-through: ingest hit paths into the cache instead of
	 * serving redirects/passthroughs forever. */
	mode: 'redirect' | 'persist';
	/** Resolution of `mode`: the cache a pull-through hit lands in (the
	 * serving cache, or for the root proxy the first cache — by priority —
	 * whose subscription is persist). */
	persistInto: string | null;
	/** Ships in Nix's default config (e.g. cache.nixos.org); omitted from
	 * generated nix.conf snippets. */
	nixDefault: boolean;
}

export const DEFAULT_UPSTREAM_TTL_SECS = 7 * 24 * 60 * 60;

export function upstreamTtlSecs(upstream: Upstream): number {
	return upstream.ttl ?? DEFAULT_UPSTREAM_TTL_SECS;
}

// upstream_check.present values. UNPERSISTABLE marks entries a persist-mode
// upstream has but server-side pull-through cannot ingest (xz, oversized):
// the read path still serves/redirects them, but push filtering reports them
// missing so the next client push stores them natively instead of relying on
// an ingestion that will never happen.
export const VERDICT_ABSENT = 0;
export const VERDICT_PRESENT = 1;
export const VERDICT_UNPERSISTABLE = 2;
export type Verdict = typeof VERDICT_ABSENT | typeof VERDICT_PRESENT | typeof VERDICT_UNPERSISTABLE;

/** In-memory caps shared with pullthrough.ts: both the compressed download
 * and the decompressed NAR are buffered (zstd decompression is buffer-only,
 * and its WASM heap holds source + destination at once) inside the isolate's
 * 128 MB, alongside the pipeline's chunk buffers. Sized so the worst case
 * (incompressible 16 MB file, 32 MB NAR) peaks well under the limit. */
export const PERSIST_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const PERSIST_MAX_NAR_BYTES = 32 * 1024 * 1024;

/** Whether pull-through can ingest this narinfo's NAR server-side (see
 * pullthrough.ts): decompressible compression and within the memory caps. */
export function persistIngestible(parsed: ParsedNarInfo | null): boolean {
	if (!parsed?.url) return false;
	const compression = parsed.compression ?? (parsed.url.endsWith('.nar') ? 'none' : null);
	if (compression !== 'zstd' && compression !== 'none') return false;
	if (parsed.narSize > PERSIST_MAX_NAR_BYTES) return false;
	const fileCap = compression === 'none' ? PERSIST_MAX_NAR_BYTES : PERSIST_MAX_COMPRESSED_BYTES;
	return parsed.fileSize == null || parsed.fileSize <= fileCap;
}

/** Which verdicts let push filtering skip the path: a persist upstream only
 * covers what it can actually ingest; a redirect upstream covers anything it
 * serves. Verdicts are shared per upstream URL across caches and probe kinds,
 * so a PRESENT recorded by a redirect-mode HEAD (no ingestibility knowledge)
 * can transiently let a persist-mode filter skip an unpersistable path; the
 * read path and ingest actively correct such rows to UNPERSISTABLE on first
 * contact with the body, so the window is one read, not one TTL. */
function filtersPath(upstream: Upstream, verdict: Verdict): boolean {
	return (
		verdict === VERDICT_PRESENT ||
		(verdict === VERDICT_UNPERSISTABLE && upstream.mode !== 'persist')
	);
}

const BATCH = 99;
/** Max live upstream narinfo probes per request (Workers subrequest budget). */
const MAX_UPSTREAM_PROBES = 250;
const PROBE_CONCURRENCY = 10;
const ABSENT_RECHECK_MS = 24 * 60 * 60 * 1000;

export async function findExistingPaths(
	db: D1,
	cacheName: string,
	hashes: string[]
): Promise<Set<string>> {
	const existing = new Set<string>();
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < hashes.length; i += BATCH) {
		const batch = hashes.slice(i, i + BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		stmts.push(
			db
				.prepare(
					'SELECT o.store_path_hash FROM object o ' +
						'INNER JOIN cache c ON o.cache_id = c.id ' +
						'INNER JOIN nar n ON o.nar_id = n.id ' +
						"WHERE c.name = ?1 AND c.deleted_at IS NULL AND n.state = 'V' " +
						`AND o.store_path_hash IN (${placeholders})`
				)
				.bind(cacheName, ...batch)
		);
	}
	for (const result of await dbBatch<{ store_path_hash: string }>(db, stmts)) {
		for (const row of result.results) existing.add(row.store_path_hash);
	}
	return existing;
}

/** Whether an upstream_check row is still trusted, per verdict-kind cutoff. */
function verdictFresh(
	row: { present: number; checked_at: string },
	presentTtlSecs: number
): boolean {
	const checkedAt = Date.parse(row.checked_at);
	// Lazy revalidation: a "present" verdict older than the upstream's TTL is
	// treated as unknown, so the next use re-probes. Together with the matching
	// edge max-age this replaces cron-driven re-validation — an upstream that
	// GC'd an entry is noticed within one TTL of the next request for it.
	if (row.present === VERDICT_ABSENT) return checkedAt >= Date.now() - ABSENT_RECHECK_MS;
	return checkedAt >= Date.now() - presentTtlSecs * 1000;
}

/** Cached upstream verdicts for a batch of hashes: hash -> verdict. */
async function cachedVerdicts(
	db: D1,
	upstream: Upstream,
	hashes: string[]
): Promise<Map<string, Verdict>> {
	const verdicts = new Map<string, Verdict>();
	const ttlSecs = upstreamTtlSecs(upstream);
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < hashes.length; i += BATCH) {
		const batch = hashes.slice(i, i + BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		stmts.push(
			db
				.prepare(
					'SELECT store_path_hash, present, checked_at FROM upstream_check ' +
						`WHERE upstream_id = ?1 AND store_path_hash IN (${placeholders})`
				)
				.bind(upstream.id, ...batch)
		);
	}
	type Row = { store_path_hash: string; present: number; checked_at: string };
	for (const result of await dbBatch<Row>(db, stmts)) {
		for (const row of result.results) {
			if (verdictFresh(row, ttlSecs)) verdicts.set(row.store_path_hash, row.present as Verdict);
		}
	}
	return verdicts;
}

/**
 * Cached verdicts for ONE hash across many upstreams in a single query:
 * upstream id -> present. The read paths resolve one hash against the whole
 * upstream list, so this replaces a round-trip per upstream.
 */
async function cachedVerdictsAcrossUpstreams(
	db: D1,
	upstreams: Upstream[],
	hash: string
): Promise<Map<number, Verdict>> {
	const verdicts = new Map<number, Verdict>();
	if (upstreams.length === 0) return verdicts;
	const ttlById = new Map(upstreams.map((u) => [u.id, upstreamTtlSecs(u)]));
	const placeholders = upstreams.map((_, i) => `?${i + 2}`).join(', ');
	const { results } = await dbAll<{ upstream_id: number; present: number; checked_at: string }>(
		db
			.prepare(
				'SELECT upstream_id, present, checked_at FROM upstream_check ' +
					`WHERE store_path_hash = ?1 AND upstream_id IN (${placeholders})`
			)
			.bind(hash, ...upstreams.map((u) => u.id))
	);
	for (const row of results) {
		const ttlSecs = ttlById.get(row.upstream_id);
		if (ttlSecs !== undefined && verdictFresh(row, ttlSecs)) {
			verdicts.set(row.upstream_id, row.present as Verdict);
		}
	}
	return verdicts;
}

/** Batched, awaited verdict writes — for batch and background paths
 * (filterUpstreamPaths, pull-through ingestion). Serve paths record through
 * the deferred, coalesced recordVerdictDeferred instead. */
export async function recordVerdicts(
	db: D1,
	upstreamId: number,
	verdicts: { hash: string; verdict: Verdict }[]
): Promise<void> {
	const now = new Date().toISOString();
	// 4 bind params per row, stay under D1's 100-param limit.
	const ROWS_PER_STMT = 24;
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < verdicts.length; i += ROWS_PER_STMT) {
		const batch = verdicts.slice(i, i + ROWS_PER_STMT);
		const values = batch.map(
			(_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4})`
		);
		const params = batch.flatMap((v) => [upstreamId, v.hash, v.verdict, now]);
		stmts.push(
			db
				.prepare(
					'INSERT OR REPLACE INTO upstream_check (upstream_id, store_path_hash, present, checked_at) ' +
						`VALUES ${values.join(', ')}`
				)
				.bind(...params)
		);
	}
	if (stmts.length > 0) await dbBatch(db, stmts);
}

// Coalescing for the single-row verdict writes on the read paths below. Each
// is an INSERT OR REPLACE — a primary write-txn — and used to be awaited
// inline before the response, so a cold mass query (e.g. right after a
// registry edit or keypair rotation purged the passthrough edge entries)
// fired one blocking primary write per path per upstream: the same
// write-storm family as the 2026-07-08 prefetch incident. The memo skips
// re-recording an unchanged verdict within the window, and the write itself
// rides waitUntil so the response never waits on the primary. Verdicts are a
// probe cache, so a write lost to a cancelled invocation just means one
// re-probe. filterUpstreamPaths keeps its own batched, awaited writes: one
// batch per get-missing-paths call, off the serve path.
const VERDICT_WRITE_COALESCE_MS = 60_000;
const VERDICT_WRITE_MEMO_MAX_ENTRIES = 20_000;
const recentVerdictWrites = new TtlMemo<Verdict>(
	VERDICT_WRITE_COALESCE_MS,
	VERDICT_WRITE_MEMO_MAX_ENTRIES
);

// --- read-path abuse guards -------------------------------------------------
// Every per-hash defense (edge-cached 404s, the verdict cache, the memos) is
// keyed by the hash, so a distinct-hash flood bypasses them all: each miss
// would fan out to live upstream fetches and an absent-verdict primary write.
// These budgets bound that amplification. The batch push path
// (filterUpstreamPaths) is authenticated and keeps its own unguarded writes.

/** What read-path guards need; omitted (tests, batch callers) = unguarded. */
export interface ProbeGuard {
	env: Env;
	/** Client IP keying the probe budget; null degrades to a shared key. */
	ip: string | null;
}

/** Distinguishes "budget refused" from a genuine miss, so callers emit an
 *  uncacheable 404 instead of poisoning the shared edge cache (narinfo) or
 *  the redirect memo (NARs) with false negatives that would outlive the
 *  refusal. */
export const PROBE_REFUSED = Symbol('upstream probe budget refused');

/**
 * One unit of per-IP upstream-fetch budget for an edge-missed read. Fails
 * open (binding absent in dev/tests, or erroring): a refusal 404s paths that
 * exist upstream, so this is a generous abuse backstop, not admission
 * control.
 */
async function takeProbeBudget(guard: ProbeGuard | undefined): Promise<boolean> {
	const limiter = guard?.env.UPSTREAM_PROBE_LIMITER;
	if (!limiter) return true;
	try {
		const { success } = await limiter.limit({ key: `probe:${guard.ip ?? 'unknown'}` });
		if (!success) recordGuard(guard.env, 'probe');
		return success;
	} catch {
		return true;
	}
}

/**
 * Colo-wide budget for absent-verdict writes from the read path. An absent
 * row only saves a future re-probe, while unbounded absent writes are how a
 * distinct-hash flood reaches the D1 primary and permanently bloats
 * upstream_check — so this fails closed (the write is optional cache-fill).
 */
async function takeAbsentVerdictBudget(env: Env): Promise<boolean> {
	if (!env.ABSENT_VERDICT_LIMITER) return true;
	try {
		const { success } = await env.ABSENT_VERDICT_LIMITER.limit({ key: 'absent-verdict' });
		if (!success) recordGuard(env, 'verdict');
		return success;
	} catch {
		return false;
	}
}

function recordVerdictDeferred(
	db: D1,
	ctx: ExecutionContext | undefined,
	upstreamId: number,
	hash: string,
	verdict: Verdict,
	env?: Env
): void {
	// Attacker-shaped keys (arbitrarily deep fake nar paths) must not become
	// permanent rows; legit keys stay well under this (a 32-char hash, or
	// nar/<hash>/sha256:<hex>.nar).
	if (hash.length > 256) return;
	const key = `${upstreamId}:${hash}`;
	if (recentVerdictWrites.get(key) === verdict) return;
	recentVerdictWrites.set(key, verdict);
	const write = (async () => {
		if (verdict === VERDICT_ABSENT && env && !(await takeAbsentVerdictBudget(env))) {
			// Undo the coalesce marker so an organic miss can record once the
			// budget window rolls.
			recentVerdictWrites.delete(key);
			return;
		}
		await recordVerdicts(db, upstreamId, [{ hash, verdict }]);
	})().catch(() => {});
	ctx?.waitUntil(write);
}

function headVerdict(res: Response): Verdict | null {
	return res.status === 200 ? VERDICT_PRESENT : res.status === 404 ? VERDICT_ABSENT : null;
}

/**
 * Verdict for a fetched narinfo body: mis-signed entries count as absent
 * (rechecked on the daily absent cadence, so a later re-signing is picked
 * up), and for a persist-mode upstream the body is checked for server-side
 * ingestibility, so push filtering can distinguish "the upstream covers
 * this" from "present but only reachable by redirect".
 */
export async function classifyNarinfo(upstream: Upstream, text: string): Promise<Verdict> {
	const parsed = parseNarInfo(text);
	if (upstream.publicKey && !(await parsedNarInfoSignatureValid(parsed, upstream.publicKey))) {
		return VERDICT_ABSENT;
	}
	if (upstream.mode === 'persist' && !persistIngestible(parsed)) {
		return VERDICT_UNPERSISTABLE;
	}
	return VERDICT_PRESENT;
}

/**
 * Live existence probe for one narinfo (or, with a `nar:` pseudo-hash, one
 * NAR file). Returns a Verdict, or null on transient trouble. Keyed and
 * persist-mode upstreams need the body (signature / ingestibility); plain
 * redirect probes stay HEADs.
 */
export async function probeUpstream(upstream: Upstream, hash: string): Promise<Verdict | null> {
	try {
		if (hash.startsWith('nar:')) {
			const res = await fetch(`${upstream.url}/${hash.slice('nar:'.length)}`, { method: 'HEAD' });
			return headVerdict(res);
		}
		const url = `${upstream.url}/${hash}.narinfo`;
		if (!upstream.publicKey && upstream.mode !== 'persist') {
			const res = await fetch(url, { method: 'HEAD' });
			return headVerdict(res);
		}
		const res = await fetch(url);
		if (res.status === 404) return VERDICT_ABSENT;
		if (res.status !== 200) return null;
		return await classifyNarinfo(upstream, await res.text());
	} catch {
		return null;
	}
}

/**
 * Filter out hashes that exist in any configured upstream. Probes are capped
 * per request; anything over the cap is conservatively treated as missing
 * (worst case the client pushes a path we could have skipped).
 *
 * mode=persist upstreams only filter paths that server-side pull-through can
 * actually ingest; anything it cannot (xz, oversized) is reported missing so
 * the next client push stores it natively, instead of being stuck at
 * redirect-tier forever. `ignore_upstream_cache_filter` remains the escape
 * hatch when a client wants everything stored locally regardless.
 */
export async function filterUpstreamPaths(
	db: D1,
	upstreams: Upstream[],
	missing: string[]
): Promise<string[]> {
	let remaining = missing;
	let probeBudget = MAX_UPSTREAM_PROBES;

	for (const upstream of upstreams) {
		if (remaining.length === 0) break;

		const cached = await cachedVerdicts(db, upstream, remaining);
		const unknown = remaining.filter((h) => !cached.has(h));

		const toProbe = unknown.slice(0, probeBudget);
		probeBudget -= toProbe.length;
		const probed: { hash: string; verdict: Verdict }[] = [];
		for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
			const batch = toProbe.slice(i, i + PROBE_CONCURRENCY);
			const results = await Promise.all(
				batch.map(async (hash) => {
					const verdict = await probeUpstream(upstream, hash);
					return verdict === null ? null : { hash, verdict };
				})
			);
			probed.push(...results.filter((r): r is { hash: string; verdict: Verdict } => r !== null));
		}
		if (probed.length > 0) {
			await recordVerdicts(db, upstream.id, probed).catch((e) =>
				console.warn(`upstream_check record failed: ${e}`)
			);
		}

		const covered = new Set<string>();
		for (const [hash, v] of cached) if (filtersPath(upstream, v)) covered.add(hash);
		for (const p of probed) if (filtersPath(upstream, p.verdict)) covered.add(p.hash);
		remaining = remaining.filter((h) => !covered.has(h));
	}

	return remaining;
}

/**
 * Upstream passthrough for the read path: fetch the upstream's narinfo
 * verbatim (it carries the upstream's signature, which clients already
 * trust). Together with the NAR redirect below, this makes a cache a complete
 * substituter for closures whose upstream-available paths were never pushed
 * (get-missing-paths filters them out), so `nix copy --from` works.
 *
 * Returns the narinfo text plus the upstream that served it, so callers can
 * apply the upstream's TTL to the response and trigger pull-through
 * persistence via `persistInto`.
 */
export async function fetchUpstreamNarInfo(
	db: D1,
	upstreams: Upstream[],
	storePathHash: string,
	ctx: ExecutionContext | undefined,
	guard?: ProbeGuard
): Promise<{ text: string; upstream: Upstream } | null | typeof PROBE_REFUSED> {
	const cached = await cachedVerdictsAcrossUpstreams(db, upstreams, storePathHash);
	let allowed: boolean | undefined;
	for (const upstream of upstreams) {
		const verdict = cached.get(upstream.id);
		if (verdict === VERDICT_ABSENT) continue;
		// Every non-absent case fetches the upstream live (narinfo bodies are
		// never stored in D1), so the whole loop rides one budget take.
		if (!(allowed ??= await takeProbeBudget(guard))) return PROBE_REFUSED;

		try {
			const res = await fetch(`${upstream.url}/${storePathHash}.narinfo`);
			if (res.status === 200) {
				const text = await res.text();
				// Recording on any change actively corrects verdicts probed without
				// ingestibility knowledge (e.g. a redirect-mode HEAD before the
				// upstream flipped to persist), and records mis-signed bodies absent
				// (rechecked daily), so a re-signed upstream entry recovers on its
				// own. The ABSENT case always differs from `verdict` — the loop
				// skipped upstreams already known absent.
				const fresh = await classifyNarinfo(upstream, text);
				if (verdict !== fresh) {
					recordVerdictDeferred(db, ctx, upstream.id, storePathHash, fresh, guard?.env);
				}
				if (fresh === VERDICT_ABSENT) continue;
				return { text, upstream };
			}
			if (res.status === 404) {
				recordVerdictDeferred(db, ctx, upstream.id, storePathHash, VERDICT_ABSENT, guard?.env);
			} else {
				// Unexpected status (rate limit, block, outage): worth surfacing,
				// since the caller silently treats it as a miss.
				console.warn(`upstream ${upstream.url} returned ${res.status} for ${storePathHash}`);
			}
		} catch (e) {
			// transient upstream trouble: fall through to the next upstream
			console.warn(`upstream ${upstream.url} fetch failed for ${storePathHash}: ${e}`);
		}
	}
	return null;
}

/**
 * URL of an upstream copy of a NAR file (e.g. "nar/<filehash>.nar.xz").
 * Verdicts ride the upstream_check table under a `nar:` pseudo-hash so hot
 * misses don't HEAD the upstream on every download; like the narinfo
 * verdicts, "present" is trusted for the upstream's TTL (an upstream GC'ing
 * a NAR inside that window would leave a stale redirect until re-probe).
 */
export async function findUpstreamNar(
	db: D1,
	upstreams: Upstream[],
	narPath: string,
	ctx: ExecutionContext | undefined,
	guard?: ProbeGuard
): Promise<string | null | typeof PROBE_REFUSED> {
	const key = `nar:${narPath}`;
	const cached = await cachedVerdictsAcrossUpstreams(db, upstreams, key);
	let allowed: boolean | undefined;
	for (const upstream of upstreams) {
		const url = `${upstream.url}/${narPath}`;
		const verdict = cached.get(upstream.id);
		if (verdict === VERDICT_ABSENT) continue;
		if (verdict !== undefined) return url;
		if (!(allowed ??= await takeProbeBudget(guard))) return PROBE_REFUSED;
		// No signature check on NARs: the client verifies the downloaded bytes
		// against the NarHash of the (signature-checked) narinfo that named them.
		const probed = await probeUpstream(upstream, key);
		if (probed !== null) {
			recordVerdictDeferred(db, ctx, upstream.id, key, probed, guard?.env);
		}
		if (probed === VERDICT_PRESENT) return url;
	}
	return null;
}

// Per-isolate memo of upstream-NAR redirect resolution. The 302 for an
// upstream-held NAR is minted in the gateway (whose cache is disabled), so a
// fleet pulling the same closure re-resolves the same NAR once per client per
// download — at least a verdict read each time. The memo collapses that to
// one resolution per window. Hits and misses both memoize: a miss is already
// sticky for a day at the D1 layer (absent verdicts), and a hit going stale
// mid-window at worst redirects to a URL the client then 404s on and retries
// elsewhere — the downloaded bytes are always verified against the narinfo's
// NarHash regardless. Registry edits reach redirects within this TTL plus the
// upstreamConfig memo's.
const NAR_REDIRECT_TTL_MS = 5 * 60 * 1000;
const NAR_REDIRECT_MEMO_MAX_ENTRIES = 20_000;
const narRedirectMemo = new TtlMemo<string | null>(
	NAR_REDIRECT_TTL_MS,
	NAR_REDIRECT_MEMO_MAX_ENTRIES
);

/**
 * Memoized upstream-NAR redirect URL for a cache — or, with a null cache, for
 * the root proxy against the union of live caches' upstreams. Keyed per cache
 * (upstream sets differ per cache); the root scope keys under `~`, which
 * CACHE_NAME_RE keeps out of real cache names. Resolution reads a replica;
 * verdict writes are deferred (recordVerdictDeferred).
 */
export async function upstreamNarRedirect(
	env: Env,
	ctx: ExecutionContext | undefined,
	cache: { id: number; name: string } | null,
	filename: string,
	ip?: string | null
): Promise<string | null> {
	const key = `${cache ? cache.name : '~'}:${filename}`;
	const cached = narRedirectMemo.get(key);
	if (cached !== undefined) return cached;
	const session = readSession(env.ATTIC_DB);
	const upstreams = cache
		? await upstreamsForCache(session, cache)
		: await allLiveUpstreams(session);
	const url = await findUpstreamNar(session, upstreams, `nar/${filename}`, ctx, {
		env,
		ip: ip ?? null
	});
	// A refused budget is not a verdict: skip the memo so organic requests
	// keep resolving once the window rolls.
	if (url === PROBE_REFUSED) return null;
	narRedirectMemo.set(key, url);
	return url;
}

// --- registry resolution -----------------------------------------------------

export type UpstreamMode = 'off' | 'redirect' | 'persist';

/** The single spelling of mode-string normalization: unknown values degrade
 * to redirect (the safe default) everywhere — resolution, admin CRUD, forms. */
export function normalizeUpstreamMode(raw: unknown): UpstreamMode {
	return raw === 'persist' ? 'persist' : raw === 'off' ? 'off' : 'redirect';
}

export interface RegistryRow {
	id: number;
	url: string;
	public_key: string | null;
	ttl: number | null;
	default_mode: string;
	enforced: number;
	position: number;
	nix_default: number;
}

export interface UpstreamConfig {
	/** Registry rows in query order (admin-controlled position). */
	upstreams: RegistryRow[];
	/** cache id -> upstream id -> override mode. */
	overrides: Map<number, Map<number, string>>;
	/** Live caches ordered by (priority, name) — the persistInto tiebreak. */
	caches: { id: number; name: string }[];
}

// Read-path misses arrive in mass-query bursts; the registry is tiny and
// changes rarely, so memoize the whole config per isolate. Config edits lag
// at most the TTL, which is negligible next to the upstream-TTL edge caching
// of the responses built from it (edits also purge those; see the admin
// actions).
const UPSTREAMS_MEMO_TTL_MS = 60_000;
let configMemo: { at: number; value: Promise<UpstreamConfig> } | null = null;

export function clearUpstreamsMemo(): void {
	configMemo = null;
}

/** Uncached registry load; admin surfaces (registryUsage) share it so their
 * resolution can never drift from the read path's. */
export async function fetchUpstreamConfig(db: D1): Promise<UpstreamConfig> {
	const [upstreams, subs, caches] = await dbBatch(db, [
		db.prepare(
			'SELECT id, url, public_key, ttl, default_mode, enforced, position, nix_default ' +
				'FROM upstream ORDER BY position, id'
		),
		db.prepare('SELECT cache_id, upstream_id, mode FROM cache_upstream'),
		db.prepare('SELECT id, name FROM cache WHERE deleted_at IS NULL ORDER BY priority, name')
	]);
	const overrides = new Map<number, Map<number, string>>();
	for (const row of subs.results as { cache_id: number; upstream_id: number; mode: string }[]) {
		let entry = overrides.get(row.cache_id);
		if (!entry) overrides.set(row.cache_id, (entry = new Map()));
		entry.set(row.upstream_id, row.mode);
	}
	return {
		upstreams: upstreams.results as RegistryRow[],
		overrides,
		caches: caches.results as { id: number; name: string }[]
	};
}

function upstreamConfig(db: D1): Promise<UpstreamConfig> {
	if (configMemo && Date.now() - configMemo.at < UPSTREAMS_MEMO_TTL_MS) {
		return configMemo.value;
	}
	const value = fetchUpstreamConfig(db);
	configMemo = { at: Date.now(), value };
	// A failed load must not be memoized as a rejected promise for the TTL —
	// but only clear our own entry (a newer memo may have replaced it).
	value.catch(() => {
		if (configMemo?.value === value) configMemo = null;
	});
	return value;
}

/**
 * A cache's effective mode for one registry entry: the override row when it
 * exists, the registry default otherwise. Enforced entries participate at
 * least as redirect — a cache can decline persist, never the trust itself.
 */
export function effectiveUpstreamMode(
	entry: { default_mode: string; enforced: number },
	override: string | undefined
): UpstreamMode {
	const mode = normalizeUpstreamMode(override ?? entry.default_mode);
	if (mode === 'off' && entry.enforced) return 'redirect';
	return mode;
}

/** The enabled upstreams of one cache, in registry (position) order. */
export async function upstreamsForCache(
	db: D1,
	cache: { id: number; name: string }
): Promise<Upstream[]> {
	const config = await upstreamConfig(db);
	const overrides = config.overrides.get(cache.id);
	const out: Upstream[] = [];
	for (const entry of config.upstreams) {
		const mode = effectiveUpstreamMode(entry, overrides?.get(entry.id));
		if (mode === 'off') continue;
		out.push({
			id: entry.id,
			url: entry.url,
			publicKey: entry.public_key,
			ttl: entry.ttl,
			mode,
			persistInto: mode === 'persist' ? cache.name : null,
			nixDefault: entry.nix_default === 1
		});
	}
	return out;
}

/**
 * The root proxy's upstream set: every registry entry enabled for at least
 * one live cache, in registry (position) order. persistInto resolves to the first cache
 * (by priority, name) whose effective mode is persist. With no live caches,
 * enforced/default-enabled entries still serve the root.
 */
export async function allLiveUpstreams(db: D1): Promise<Upstream[]> {
	const config = await upstreamConfig(db);
	const out: Upstream[] = [];
	for (const entry of config.upstreams) {
		let enabled = config.caches.length === 0 && effectiveUpstreamMode(entry, undefined) !== 'off';
		let persistInto: string | null = null;
		for (const cache of config.caches) {
			const mode = effectiveUpstreamMode(entry, config.overrides.get(cache.id)?.get(entry.id));
			if (mode === 'off') continue;
			enabled = true;
			if (mode === 'persist' && !persistInto) persistInto = cache.name;
		}
		if (!enabled) continue;
		out.push({
			id: entry.id,
			url: entry.url,
			publicKey: entry.public_key,
			ttl: entry.ttl,
			mode: persistInto ? 'persist' : 'redirect',
			persistInto,
			nixDefault: entry.nix_default === 1
		});
	}
	return out;
}
