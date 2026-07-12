// Root proxy resolution: which caches may this requester read, and which one
// serves a given hash. Pure logic here; HTTP handlers live in router.ts and
// the re-signing store path in store.ts.

import { permissionForCache, type VerifiedToken } from '../attic/token';
import { generateKeypair } from '../attic/signing';
import type { LiveCacheRow } from './db';

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
// to ABSENT_TTL_MS. Size-capped as a mass-query backstop.
const ABSENT_TTL_MS = 60_000;
const ABSENT_MAX_ENTRIES = 20_000;
const absentStorePaths = new Map<string, number>();

export function isKnownAbsent(storePathHash: string): boolean {
	const until = absentStorePaths.get(storePathHash);
	if (until === undefined) return false;
	if (Date.now() > until) {
		absentStorePaths.delete(storePathHash);
		return false;
	}
	return true;
}

export function recordAbsent(storePathHash: string): void {
	if (absentStorePaths.size >= ABSENT_MAX_ENTRIES) absentStorePaths.clear();
	absentStorePaths.set(storePathHash, Date.now() + ABSENT_TTL_MS);
}

/** Called after an upload lands the path, so this isolate stops 404ing it. */
export function clearAbsent(storePathHash: string): void {
	absentStorePaths.delete(storePathHash);
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
