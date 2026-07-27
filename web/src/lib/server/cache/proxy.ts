// Root proxy resolution: which caches may this requester read, and which one
// serves a given hash. Pure logic here; HTTP handlers live in router.ts and
// the re-signing store path in store.ts.

import { permissionForCache, type VerifiedToken } from '../attic/token';
import { generateKeypair } from '../attic/signing';
import { TOUCH_GRANULARITY_MS, type LiveCacheRow } from './db';
import { TtlMemo } from './ttl-memo';

type Env = App.Platform['env'];

/**
 * The candidate the requester may read — public caches, or private ones the
 * token may pull from — lowest priority first, then name, so resolution is
 * deterministic across requests.
 */
export function pickReadableWinner(
	token: VerifiedToken | null,
	candidates: LiveCacheRow[]
): LiveCacheRow | null {
	const readable = candidates
		.filter((row) => row.is_public === 1 || permissionForCache(token, row.name).pull)
		.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
	return readable[0] ?? null;
}

// Negative memo for root-narinfo misses. The root advertises WantMassQuery,
// so closure walks re-ask for every absent path; without this each ask is a
// D1 query (per-cache 404s are negative-cached at the edge instead, but root
// readability is token-dependent, so only token-independent absence — an
// empty candidate set — is safe to remember). Per-isolate and TTL-bounded:
// uploads can't purge it, so a just-pushed path may 404 at the root for up
// to ABSENT_TTL_MS. The size cap matters here: mass queries of mostly-absent
// closures are exactly what fills it, and TtlMemo's sweep-first eviction
// reclaims expired entries instead of wiping the live set back onto D1.
const ABSENT_TTL_MS = 60_000;
// Sized like the touch/prefetch memos: a fleet's cold mass query can sustain
// hundreds of distinct misses/sec, and 20k (333/sec x 60s TTL) was the one
// cap such a storm could realistically fill. ~150 B/entry, so the worst case
// is a few MB.
const ABSENT_MAX_ENTRIES = 50_000;
const absentStorePaths = new TtlMemo<true>(ABSENT_TTL_MS, ABSENT_MAX_ENTRIES);

export function isKnownAbsent(storePathHash: string): boolean {
	return absentStorePaths.get(storePathHash) === true;
}

export function recordAbsent(storePathHash: string): void {
	absentStorePaths.set(storePathHash, true);
}

/** Called after an upload lands the path, so this isolate stops 404ing it. */
export function clearAbsent(storePathHash: string): void {
	absentStorePaths.delete(storePathHash);
}

// Download-touch coalescing, first of two layers. Retention is
// download-driven: every NAR GET would otherwise UPDATE last_accessed_at on
// the D1 write primary — even on edge cache hits, since the touch runs in the
// gateway (router.ts). That couples read throughput to the single-primary
// write ceiling and steals write budget from uploads.
//
// This memo is per isolate, so its coalescing factor falls away under exactly
// the load that matters: a fleet's cold mass query spreads across colos and
// isolates that each see a given NAR about once. It is therefore only the
// cheap pre-filter — it skips both statements entirely for the repeats it does
// catch. The load-bearing guarantee is the recency predicate the probe and
// UPDATE share, which bounds writes per object per window no matter how many
// isolates race. Both layers use TOUCH_GRANULARITY_MS so there is one window
// to reason about: a memo shorter than it would only buy redundant probes.
const TOUCH_MEMO_MAX_ENTRIES = 50_000;
const recentTouches = new TtlMemo<true>(TOUCH_GRANULARITY_MS, TOUCH_MEMO_MAX_ENTRIES);

/**
 * Whether the download-touch for (cacheId, narHash) should be attempted now,
 * recording the decision. Returns false when this isolate already touched it
 * within TOUCH_GRANULARITY_MS. Keyed per cache because the touch attributes
 * the access to that cache's object rows.
 */
export function shouldTouch(cacheId: number, narHash: string): boolean {
	const key = `${cacheId}:${narHash}`;
	if (recentTouches.get(key)) return false;
	recentTouches.set(key, true);
	return true;
}

export function proxyKeyName(env: Env): string {
	try {
		if (env.CACHE_BASE_URL) return `${new URL(env.CACHE_BASE_URL).hostname}-1`;
	} catch {
		// fall through
	}
	return 'nimbus-proxy-1';
}

// The keypair is write-once (INSERT OR IGNORE, no rotation path), so one D1
// read per isolate suffices — same idea as the signing-key cache in signing.ts.
let proxyKeypair: Promise<string> | undefined;

/**
 * The server-wide proxy signing keypair, generated lazily into server_config.
 * INSERT OR IGNORE + re-read makes concurrent first uses converge on one key.
 */
export function getProxyKeypair(env: Env): Promise<string> {
	if (!proxyKeypair) {
		proxyKeypair = loadProxyKeypair(env);
		proxyKeypair.catch(() => (proxyKeypair = undefined));
	}
	return proxyKeypair;
}

async function loadProxyKeypair(env: Env): Promise<string> {
	const read = () =>
		env.ATTIC_DB.prepare("SELECT value FROM server_config WHERE key = 'proxy_keypair'").first<{
			value: string;
		}>();

	const existing = await read();
	if (existing) return existing.value;

	const keypair = await generateKeypair(proxyKeyName(env));
	await env.ATTIC_DB.prepare(
		"INSERT OR IGNORE INTO server_config (key, value) VALUES ('proxy_keypair', ?1)"
	)
		.bind(keypair)
		.run();
	const row = await read();
	if (!row) throw new Error('proxy keypair write failed');
	return row.value;
}
