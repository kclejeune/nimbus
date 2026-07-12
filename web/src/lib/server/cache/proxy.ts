// Root proxy resolution: which caches may this requester read, and which one
// serves a given hash. Pure logic here; HTTP handlers live in router.ts and
// the re-signing store path in store.ts.

import { permissionForCache, type VerifiedToken } from '../attic/token';
import { generateKeypair } from '../attic/signing';
import type { LiveCacheRow } from './db';

type Env = App.Platform['env'];

/** Public caches plus private caches the token may pull from. */
export function readableCacheSet(
	token: VerifiedToken | null,
	caches: LiveCacheRow[]
): Map<string, LiveCacheRow> {
	const readable = new Map<string, LiveCacheRow>();
	for (const row of caches) {
		if (row.is_public === 1 || permissionForCache(token, row.name).pull) {
			readable.set(row.name, row);
		}
	}
	return readable;
}

/** Lowest priority wins, then name — deterministic across requests. */
export function pickWinner(
	candidateNames: string[],
	readable: Map<string, LiveCacheRow>
): LiveCacheRow | null {
	const rows = candidateNames
		.map((name) => readable.get(name))
		.filter((r): r is LiveCacheRow => r !== undefined)
		.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
	return rows[0] ?? null;
}

export function proxyKeyName(env: Env): string {
	try {
		if (env.CACHE_BASE_URL) return `${new URL(env.CACHE_BASE_URL).hostname}-1`;
	} catch {
		// fall through
	}
	return 'nimbus-proxy-1';
}

/**
 * The server-wide proxy signing keypair, generated lazily into server_config.
 * INSERT OR IGNORE + re-read makes concurrent first uses converge on one key.
 */
export async function getProxyKeypair(env: Env): Promise<string> {
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
