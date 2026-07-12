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
