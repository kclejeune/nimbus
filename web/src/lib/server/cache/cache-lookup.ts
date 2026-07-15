// Memoized cache-row resolution for the hot serve/authorization and upload
// paths, which look the same row up once per store path of a mass-query or
// push burst. Cache rows change rarely, so a short TTL sheds most of those
// (replica) reads. Kept here with its hot-path consumers — mirroring the
// upstreamConfig memo in missing-paths.ts — rather than in db.ts, which is
// the stateless query mirror of the Rust worker's d1.rs.
//
// Cache-config mutations call invalidateCacheRow so the mutating isolate
// re-reads promptly; staleness stays bounded by the TTL there and in other
// isolates alike, the same contract upstreamConfig accepts. A keypair rotation is the most sensitive
// edit — an isolate holding a stale row keeps signing under the old key until
// the entry expires (its edge entries were already purged, so this is a
// bounded re-sign, not a security hole) — hence the short TTL. Returned rows
// are shared across callers in the isolate; treat them read-only.

import type { D1Database } from '@cloudflare/workers-types';
import { findCache, readSession, type CacheRow } from './db';
import { TtlMemo } from './ttl-memo';

const CACHE_ROW_TTL_MS = 30_000;
// A miss (unknown/just-deleted cache) is remembered only briefly so a
// create-then-serve race resolves quickly even in isolates that never saw the
// create (where invalidateCacheRow cannot reach).
const CACHE_ROW_MISS_TTL_MS = 5_000;
const CACHE_ROW_MEMO_MAX_ENTRIES = 10_000;
const cacheRowMemo = new TtlMemo<CacheRow | null>(CACHE_ROW_TTL_MS, CACHE_ROW_MEMO_MAX_ENTRIES);

/** Drop memoized cache row(s); called by every cache-config mutation (the sole
 * choke point for cache-row writes). Pass no name to clear all, e.g. in tests. */
export function invalidateCacheRow(name?: string): void {
	if (name === undefined) cacheRowMemo.clear();
	else cacheRowMemo.delete(name);
}

/** findCache with the per-isolate memo, reading a replica session derived
 * here — the memo is shared isolate-wide, so a per-caller source choice
 * could not buy freshness anyway. Serve and upload paths — admin and
 * cache-config paths take the live db.findCache. */
export async function findCacheCached(db: D1Database, name: string): Promise<CacheRow | null> {
	const cached = cacheRowMemo.get(name);
	if (cached !== undefined) return cached;
	const row = await findCache(readSession(db), name);
	cacheRowMemo.set(name, row, row ? CACHE_ROW_TTL_MS : CACHE_ROW_MISS_TTL_MS);
	return row;
}
