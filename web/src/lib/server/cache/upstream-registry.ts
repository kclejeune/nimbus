// Admin CRUD for the instance-level upstream registry (see missing-paths.ts
// for how the read paths resolve it). Every writer clears the per-isolate
// config memo and, when given an execution context, purges the edge-cached
// upstream passthroughs its change invalidates — callers only translate
// their local authority (admin session / ct token) into the witness options.

import { listCacheNames } from '$lib/server/db/queries';
import { purgeTagsBestEffort } from './gc';
import {
	clearUpstreamsMemo,
	effectiveUpstreamMode,
	fetchUpstreamConfig,
	normalizeUpstreamMode,
	type UpstreamMode
} from './missing-paths';
import type { ExecutionContext } from './platform';
import { cacheTag, ROOT_UPSTREAM_TAG_NS, upstreamPassthroughTag } from './store';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];

export interface RegistryUpstream {
	id: number;
	url: string;
	/** Never null: trust is key-based (NOT NULL column). */
	publicKey: string;
	/** Seconds; never null (NOT NULL column). */
	ttl: number;
	defaultMode: UpstreamMode;
	enforced: boolean;
	/** Query order (0-based, admin-controlled). */
	position: number;
	createdAt: string;
}

export interface UpstreamInput {
	url: string;
	/** Required: upstream trust is key-based. */
	publicKey: string;
	/** Seconds; required. */
	ttl: number;
	defaultMode: UpstreamMode;
	enforced: boolean;
}

/**
 * Evict every edge-cached upstream passthrough: a registry change alters what
 * all caches serve for upstream-available paths. Local narinfos are untouched
 * (passthroughs carry their own tag), so this never cold-starts real content.
 */
async function purgeUpstreamEdge(db: D1, ctx: ExecutionContext | undefined): Promise<void> {
	if (!ctx) return;
	const names = await listCacheNames(db);
	await purgeTagsBestEffort(ctx, [
		cacheTag(ROOT_UPSTREAM_TAG_NS),
		...names.map(upstreamPassthroughTag)
	]);
}

export async function listRegistry(db: D1): Promise<RegistryUpstream[]> {
	const { results } = await db
		.prepare(
			'SELECT id, url, public_key, ttl, default_mode, enforced, position, created_at ' +
				'FROM upstream ORDER BY position, id'
		)
		.all<{
			id: number;
			url: string;
			public_key: string;
			ttl: number;
			default_mode: string;
			enforced: number;
			position: number;
			created_at: string;
		}>();
	return results.map((row) => ({
		id: row.id,
		url: row.url,
		publicKey: row.public_key,
		ttl: row.ttl,
		defaultMode: normalizeUpstreamMode(row.default_mode),
		enforced: row.enforced === 1,
		position: row.position,
		createdAt: row.created_at
	}));
}

/** Returns false when the URL is already registered. New entries land at the
 * end of the query order. */
export async function createUpstream(
	db: D1,
	input: UpstreamInput,
	opts: { ctx?: ExecutionContext } = {}
): Promise<boolean> {
	const result = await db
		.prepare(
			'INSERT INTO upstream (url, public_key, ttl, default_mode, enforced, position, created_at) ' +
				'VALUES (?1, ?2, ?3, ?4, ?5, ' +
				'(SELECT COALESCE(MAX(position), -1) + 1 FROM upstream), ?6) ' +
				'ON CONFLICT (url) DO NOTHING'
		)
		.bind(
			input.url,
			input.publicKey,
			input.ttl,
			input.defaultMode,
			input.enforced ? 1 : 0,
			new Date().toISOString()
		)
		.run();
	clearUpstreamsMemo();
	const created = (result.meta.changes ?? 0) > 0;
	if (created) await purgeUpstreamEdge(db, opts.ctx);
	return created;
}

/**
 * Persist a new query order: `orderedIds` is the full registry in the
 * desired order. Reordering changes which upstream serves a path first, so
 * the edge-cached passthroughs are purged like any other registry change.
 */
export async function setUpstreamPositions(
	db: D1,
	orderedIds: number[],
	opts: { ctx?: ExecutionContext } = {}
): Promise<void> {
	if (orderedIds.length === 0) return;
	await db.batch(
		orderedIds.map((id, index) =>
			db.prepare('UPDATE upstream SET position = ?2 WHERE id = ?1').bind(id, index)
		)
	);
	clearUpstreamsMemo();
	await purgeUpstreamEdge(db, opts.ctx);
}

/**
 * Update a registry entry. A URL or public-key change is a change of trust
 * identity: every cached verdict recorded under it is wiped so reads and
 * push filtering re-probe under the new identity.
 */
export async function updateUpstream(
	db: D1,
	id: number,
	input: UpstreamInput,
	opts: { ctx?: ExecutionContext } = {}
): Promise<void> {
	const before = await db
		.prepare('SELECT url, public_key FROM upstream WHERE id = ?1')
		.bind(id)
		.first<{ url: string; public_key: string }>();
	await db
		.prepare(
			'UPDATE upstream SET url = ?2, public_key = ?3, ttl = ?4, default_mode = ?5, enforced = ?6 ' +
				'WHERE id = ?1'
		)
		.bind(id, input.url, input.publicKey, input.ttl, input.defaultMode, input.enforced ? 1 : 0)
		.run();
	if (before && (before.url !== input.url || before.public_key !== input.publicKey)) {
		await db.prepare('DELETE FROM upstream_check WHERE upstream_id = ?1').bind(id).run();
	}
	clearUpstreamsMemo();
	await purgeUpstreamEdge(db, opts.ctx);
}

export async function deleteUpstream(
	db: D1,
	id: number,
	opts: { ctx?: ExecutionContext } = {}
): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM cache_upstream WHERE upstream_id = ?1').bind(id),
		db.prepare('DELETE FROM upstream_check WHERE upstream_id = ?1').bind(id),
		db.prepare('DELETE FROM upstream WHERE id = ?1').bind(id)
	]);
	clearUpstreamsMemo();
	await purgeUpstreamEdge(db, opts.ctx);
}

/** A cache's subscription rows: upstream id -> override mode. */
export async function cacheUpstreamOverrides(
	db: D1,
	cacheId: number
): Promise<Map<number, UpstreamMode>> {
	const { results } = await db
		.prepare('SELECT upstream_id, mode FROM cache_upstream WHERE cache_id = ?1')
		.bind(cacheId)
		.all<{ upstream_id: number; mode: string }>();
	return new Map(results.map((r) => [r.upstream_id, normalizeUpstreamMode(r.mode)]));
}

/**
 * Replace a cache's subscription overrides: `null` mode means inherit the
 * registry default (the override row is removed). Enabling persist is
 * trust-affecting (pull-through re-signs foreign content under the cache's
 * key), so it demands the `allowPersist` witness — entry points translate
 * their authority (admin session / ct token) into it.
 */
export async function setCacheUpstreamModes(
	db: D1,
	cacheId: number,
	modes: { upstreamId: number; mode: UpstreamMode | null }[],
	opts: { allowPersist: boolean; ctx?: ExecutionContext; cacheName?: string }
): Promise<void> {
	if (!opts.allowPersist && modes.some(({ mode }) => mode === 'persist')) {
		throw new Error('Enabling pull-through persistence requires trust-admin authority');
	}
	const stmts = modes.map(({ upstreamId, mode }) =>
		mode === null
			? db
					.prepare('DELETE FROM cache_upstream WHERE cache_id = ?1 AND upstream_id = ?2')
					.bind(cacheId, upstreamId)
			: db
					.prepare(
						'INSERT INTO cache_upstream (cache_id, upstream_id, mode) VALUES (?1, ?2, ?3) ' +
							'ON CONFLICT (cache_id, upstream_id) DO UPDATE SET mode = excluded.mode'
					)
					.bind(cacheId, upstreamId, mode)
	);
	if (stmts.length === 0) return;
	await db.batch(stmts);
	clearUpstreamsMemo();
	// The cache's edge-cached passthroughs advertise upstreams it may no
	// longer use (their NAR routes recompute live and would 404).
	if (opts.cacheName) {
		await purgeTagsBestEffort(opts.ctx, [upstreamPassthroughTag(opts.cacheName)]);
	}
}

/** How many live caches use each registry entry, by effective mode — the
 * admin page's usage column. Shares the read path's loader and resolution,
 * so it can never drift from what serving actually does. */
export async function registryUsage(
	db: D1
): Promise<Map<number, { redirect: number; persist: number }>> {
	const config = await fetchUpstreamConfig(db);
	const usage = new Map<number, { redirect: number; persist: number }>();
	for (const entry of config.upstreams) {
		const counts = { redirect: 0, persist: 0 };
		for (const cache of config.caches) {
			const mode = effectiveUpstreamMode(entry, config.overrides.get(cache.id)?.get(entry.id));
			if (mode !== 'off') counts[mode]++;
		}
		usage.set(entry.id, counts);
	}
	return usage;
}
