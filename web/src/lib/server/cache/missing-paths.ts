// POST /_api/v1/get-missing-paths, ported from the Rust worker and extended
// with upstream filtering: paths already fetchable from the cache's configured
// upstream binary caches (cache.upstream_caches, default cache.nixos.org) are
// not reported as missing, so clients never push them here. Verdicts are
// cached in upstream_check (absent = rechecked daily; present = lazily
// re-probed after the upstream's TTL, since upstreams like cachix GC).
//
// An upstream may carry a public key; when it does, an entry only counts as
// present if its narinfo carries a valid signature from that key.

import { parseNarInfo, parsedNarInfoSignatureValid, type ParsedNarInfo } from '../attic/narinfo';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];

export interface Upstream {
	url: string;
	/** Nix public key (`name:base64`); non-null enforces signature checks. */
	publicKey: string | null;
	/** Seconds a "present" verdict (and its edge-cached passthrough) lives
	 * before the CDN/lazy re-probe; null = DEFAULT_UPSTREAM_TTL_SECS. The TTL
	 * doubles as the preference order — upstreams are tried longest-lived
	 * first, since a long TTL is a statement that the upstream is stable
	 * (cache.nixos.org never GCs) while a short one marks a volatile source
	 * (cachix GCs) that should neither be trusted long nor tried first. */
	ttl: number | null;
	/** persist = pull-through: ingest hit paths into the cache instead of
	 * serving redirects/passthroughs forever. */
	mode: 'redirect' | 'persist';
	/** Resolution of `mode`: the cache a pull-through hit lands in. Set by
	 * the read-path callers (per-cache: the serving cache; root: the first
	 * cache declaring the upstream as persist). */
	persistInto: string | null;
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
	const stmts = [];
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
	for (const result of await db.batch<{ store_path_hash: string }>(stmts)) {
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
	const stmts = [];
	for (let i = 0; i < hashes.length; i += BATCH) {
		const batch = hashes.slice(i, i + BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		stmts.push(
			db
				.prepare(
					'SELECT store_path_hash, present, checked_at FROM upstream_check ' +
						`WHERE upstream = ?1 AND store_path_hash IN (${placeholders})`
				)
				.bind(upstream.url, ...batch)
		);
	}
	type Row = { store_path_hash: string; present: number; checked_at: string };
	for (const result of await db.batch<Row>(stmts)) {
		for (const row of result.results) {
			if (verdictFresh(row, ttlSecs)) verdicts.set(row.store_path_hash, row.present as Verdict);
		}
	}
	return verdicts;
}

/**
 * Cached verdicts for ONE hash across many upstreams in a single query:
 * url -> present. The read paths resolve one hash against the whole upstream
 * list, so this replaces a round-trip per upstream.
 */
async function cachedVerdictsAcrossUpstreams(
	db: D1,
	upstreams: Upstream[],
	hash: string
): Promise<Map<string, Verdict>> {
	const verdicts = new Map<string, Verdict>();
	if (upstreams.length === 0) return verdicts;
	const ttlByUrl = new Map(upstreams.map((u) => [u.url, upstreamTtlSecs(u)]));
	const placeholders = upstreams.map((_, i) => `?${i + 2}`).join(', ');
	const { results } = await db
		.prepare(
			'SELECT upstream, present, checked_at FROM upstream_check ' +
				`WHERE store_path_hash = ?1 AND upstream IN (${placeholders})`
		)
		.bind(hash, ...upstreams.map((u) => u.url))
		.all<{ upstream: string; present: number; checked_at: string }>();
	for (const row of results) {
		const ttlSecs = ttlByUrl.get(row.upstream);
		if (ttlSecs !== undefined && verdictFresh(row, ttlSecs)) {
			verdicts.set(row.upstream, row.present as Verdict);
		}
	}
	return verdicts;
}

export async function recordVerdicts(
	db: D1,
	upstream: string,
	verdicts: { hash: string; verdict: Verdict }[]
): Promise<void> {
	const now = new Date().toISOString();
	// 4 bind params per row, stay under D1's 100-param limit.
	const ROWS_PER_STMT = 24;
	const stmts = [];
	for (let i = 0; i < verdicts.length; i += ROWS_PER_STMT) {
		const batch = verdicts.slice(i, i + ROWS_PER_STMT);
		const values = batch.map(
			(_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4})`
		);
		const params = batch.flatMap((v) => [upstream, v.hash, v.verdict, now]);
		stmts.push(
			db
				.prepare(
					'INSERT OR REPLACE INTO upstream_check (upstream, store_path_hash, present, checked_at) ' +
						`VALUES ${values.join(', ')}`
				)
				.bind(...params)
		);
	}
	if (stmts.length > 0) await db.batch(stmts);
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
			await recordVerdicts(db, upstream.url, probed).catch((e) =>
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
	storePathHash: string
): Promise<{ text: string; upstream: Upstream } | null> {
	const cached = await cachedVerdictsAcrossUpstreams(db, upstreams, storePathHash);
	for (const upstream of upstreams) {
		const verdict = cached.get(upstream.url);
		if (verdict === VERDICT_ABSENT) continue;

		try {
			const res = await fetch(`${upstream.url}/${storePathHash}.narinfo`);
			if (res.status === 200) {
				const text = await res.text();
				// A mis-signed body is recorded absent (rechecked daily), so a
				// GC'd-and-repushed or re-signed upstream entry recovers on its own.
				const fresh = await classifyNarinfo(upstream, text);
				if (fresh === VERDICT_ABSENT) {
					await recordVerdicts(db, upstream.url, [{ hash: storePathHash, verdict: fresh }]).catch(
						() => {}
					);
					continue;
				}
				// Recording on any change (not just first sight) actively corrects
				// verdicts probed without ingestibility knowledge (e.g. a
				// redirect-mode HEAD before the upstream flipped to persist).
				if (verdict !== fresh) {
					await recordVerdicts(db, upstream.url, [{ hash: storePathHash, verdict: fresh }]).catch(
						() => {}
					);
				}
				return { text, upstream };
			}
			if (res.status === 404) {
				await recordVerdicts(db, upstream.url, [
					{ hash: storePathHash, verdict: VERDICT_ABSENT }
				]).catch(() => {});
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
	narPath: string
): Promise<string | null> {
	const key = `nar:${narPath}`;
	const cached = await cachedVerdictsAcrossUpstreams(db, upstreams, key);
	for (const upstream of upstreams) {
		const url = `${upstream.url}/${narPath}`;
		const verdict = cached.get(upstream.url);
		if (verdict === VERDICT_ABSENT) continue;
		if (verdict !== undefined) return url;
		// No signature check on NARs: the client verifies the downloaded bytes
		// against the NarHash of the (signature-checked) narinfo that named them.
		const probed = await probeUpstream(upstream, key);
		if (probed !== null) {
			await recordVerdicts(db, upstream.url, [{ hash: key, verdict: probed }]).catch(() => {});
		}
		if (probed === VERDICT_PRESENT) return url;
	}
	return null;
}

/** The JSON shape stored in cache.upstream_caches (writer: the settings
 * save action; reader: parseUpstreams below). */
export interface StoredUpstream {
	url: string;
	public_key: string | null;
	/** Seconds; null = DEFAULT_UPSTREAM_TTL_SECS. Doubles as query order. */
	ttl: number | null;
	mode: 'redirect' | 'persist';
}

/**
 * Parse a cache's upstream_caches column. Two formats coexist: the original
 * plain URL strings, and StoredUpstream objects written by the settings form
 * (a legacy `priority` field is ignored).
 */
export function parseUpstreams(raw: string | null | undefined): Upstream[] {
	if (!raw) return [];
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(v)) return [];
	const upstreams: Upstream[] = [];
	for (const entry of v) {
		// Legacy rows are plain URL strings; normalize before one shared path.
		const fields = (typeof entry === 'string' ? { url: entry } : (entry ?? {})) as {
			url?: unknown;
			public_key?: unknown;
			ttl?: unknown;
			mode?: unknown;
		};
		const { url, public_key, ttl, mode } = fields;
		if (typeof url !== 'string' || !url) continue;
		upstreams.push({
			url: url.replace(/\/+$/, ''),
			publicKey: typeof public_key === 'string' && public_key ? public_key : null,
			ttl: typeof ttl === 'number' && ttl > 0 ? ttl : null,
			mode: mode === 'persist' ? 'persist' : 'redirect',
			persistInto: null
		});
	}
	// Longest-lived first (see the ttl field comment); stable sort keeps the
	// configured order among ties.
	return upstreams.sort((a, b) => upstreamTtlSecs(b) - upstreamTtlSecs(a));
}

// Root-fallback misses arrive in mass-query bursts; the union is rebuilt from
// the same cache rows every time, so memoize per isolate. Config edits lag at
// most the TTL, which is negligible next to the upstream-TTL edge caching of
// the responses built from it.
const UPSTREAMS_MEMO_TTL_MS = 60_000;
let upstreamsMemo: { at: number; value: Upstream[] } | null = null;

export function clearUpstreamsMemo(): void {
	upstreamsMemo = null;
}

/**
 * The root proxy's upstream set: the union of every live cache's upstreams,
 * deduplicated by URL and tried longest-TTL first. Merging is strict: the
 * keyed entry wins over keyless (one cache demanding signature checks must
 * not be undercut by another's keyless config) and the shortest TTL wins.
 * persistInto remembers the first cache (by cache priority) that wants hits
 * pulled through into local storage. The settings UI rejects same-URL
 * declarations with conflicting keys, so the keyed-wins rule only arbitrates
 * rows written outside it.
 */
export async function allLiveUpstreams(db: D1): Promise<Upstream[]> {
	if (upstreamsMemo && Date.now() - upstreamsMemo.at < UPSTREAMS_MEMO_TTL_MS) {
		return upstreamsMemo.value;
	}
	const { results } = await db
		.prepare(
			'SELECT name, upstream_caches FROM cache WHERE deleted_at IS NULL ORDER BY priority, name'
		)
		.all<{ name: string; upstream_caches: string }>();
	const byUrl = new Map<string, Upstream>();
	for (const row of results) {
		for (const upstream of parseUpstreams(row.upstream_caches)) {
			const persistInto = upstream.mode === 'persist' ? row.name : null;
			const existing = byUrl.get(upstream.url);
			if (!existing) {
				byUrl.set(upstream.url, { ...upstream, persistInto });
				continue;
			}
			if (!existing.publicKey && upstream.publicKey) existing.publicKey = upstream.publicKey;
			existing.ttl = Math.min(upstreamTtlSecs(existing), upstreamTtlSecs(upstream));
			if (!existing.persistInto && persistInto) {
				existing.persistInto = persistInto;
				existing.mode = 'persist';
			}
		}
	}
	const value = [...byUrl.values()].sort(
		(a, b) => upstreamTtlSecs(b) - upstreamTtlSecs(a) || a.url.localeCompare(b.url)
	);
	upstreamsMemo = { at: Date.now(), value };
	return value;
}
