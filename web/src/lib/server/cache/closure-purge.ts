import { dbAll, dbBatch, dbFirst, dbRun } from './db';
import { INTEGRITY_PUSH_GRACE_MS } from './closure-repair';
import { candidateTag } from './metadata';
import { narinfoTag, ROOT_UPSTREAM_TAG_NS } from './store';
import { PURGE_TAG_LIMIT } from './purge';
import { PURGE_INTERVAL_MS } from './purge-queue';
import type { ExecutionContext } from './platform';
import type { Upstream } from './missing-paths';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];
export const MAX_PURGE_TARGETS = 10_000;
export interface PurgeTarget {
	id: number;
	store_path_hash: string;
	store_path: string;
	nar_id: number;
	created_at: string;
	detached_at: string | null;
	blocked: number;
}
type JournalObject = { id: number; hash: string; nar_hash: string | null };
interface Operation {
	id: string;
	cache_id: number;
	cache_name: string;
	objects: string;
	removed: number;
	tag_cursor: number;
	state: string;
}

const ENABLED_UPSTREAMS = `SELECT u.id,u.url,u.public_key,u.ttl,
 CASE WHEN u.enforced=1 AND COALESCE(cu.mode,u.default_mode)='off' THEN 'redirect'
 ELSE COALESCE(cu.mode,u.default_mode) END AS mode
 FROM upstream u LEFT JOIN cache_upstream cu ON cu.upstream_id=u.id AND cu.cache_id=?1
 WHERE u.enforced=1 OR COALESCE(cu.mode,u.default_mode)<>'off'`;
const UPSTREAM_CONFIG = `(SELECT json_group_array(json_array(id,url,public_key,ttl,mode))
 FROM (SELECT * FROM enabled ORDER BY id))`;

/** Read from the primary, sharing the exact fingerprint used by deletion's
 * atomic policy guard. Cached registry memos cannot authorize an auto purge. */
export async function readPurgeUpstreams(db: D1, cacheId: number, cacheName: string) {
	const row = await dbFirst<{ config: string }>(
		db
			.prepare(
				`WITH enabled AS MATERIALIZED (${ENABLED_UPSTREAMS}) SELECT ${UPSTREAM_CONFIG} AS config`
			)
			.bind(cacheId)
	);
	const config = row!.config;
	const entries = JSON.parse(config) as [number, string, string, number, 'redirect' | 'persist'][];
	const upstreams: Upstream[] = entries.map(([id, url, publicKey, ttl, mode]) => ({
		id,
		url,
		publicKey,
		ttl,
		mode,
		persistInto: mode === 'persist' ? cacheName : null,
		nixDefault: false
	}));
	return { config, upstreams };
}

// Read references from their source JSON, including uploads after GC's graph
// watermark. Apply evaluates these CTEs once inside its atomic deletion batch,
// recording the eligible IDs and their invalidation tags before deleting.
// Give the materialized child hashes TEXT affinity so SQLite can index them.
// CROSS JOIN fixes traversal order even without ANALYZE statistics: a frontier
// row probes the graph/index, and a reviewed JSON row probes the object's PK.
// The forward walk can read refs directly with indexed child lookups.
const PURGE_CTES = `WITH RECURSIVE
 enabled AS MATERIALIZED (
   ${ENABLED_UPSTREAMS}
 ), auto_policy AS MATERIALIZED (
   SELECT c.purge_broken_after_days AS days FROM cache c JOIN broken_purge_state s ON s.cache_id=c.id
   WHERE c.id=?1 AND c.deleted_at IS NULL AND c.purge_broken_after_days=?5
   AND s.policy_days=?5 AND s.upstream_config=${UPSTREAM_CONFIG}
 ), missing(hash) AS (
   SELECT value FROM json_each(?2) seed
   WHERE NOT EXISTS (SELECT 1 FROM object o JOIN nar n ON n.id=o.nar_id
     WHERE o.cache_id=?1 AND o.store_path_hash=seed.value AND n.state='V')
   AND NOT EXISTS (SELECT 1 FROM enabled u WHERE NOT EXISTS (
     SELECT 1 FROM upstream_check uc WHERE uc.upstream_id=u.id AND uc.store_path_hash=seed.value
     AND uc.present=0 AND julianday(uc.checked_at)>=julianday('now','-1 day')))
   AND (?5 IS NULL OR EXISTS (SELECT 1 FROM broken_reference b CROSS JOIN auto_policy a
     WHERE b.cache_id=?1 AND b.ref_hash=seed.value AND b.upstream_config=${UPSTREAM_CONFIG}
     AND julianday(b.first_missing_at)<=julianday('now')-a.days
     AND julianday(b.last_checked_at)>=julianday('now','-1 hour')))
 ), edges(parent,child) AS MATERIALIZED (
   SELECT o.id,CAST(substr(j.value,1,32) AS TEXT) FROM object o,json_each(o.refs) j WHERE o.cache_id=?1
 ), affected(id) AS (
   SELECT e.parent FROM missing m CROSS JOIN edges e ON e.child=m.hash
   UNION SELECT e.parent FROM affected a CROSS JOIN object o ON o.id=a.id CROSS JOIN edges e ON e.child=o.store_path_hash
 ), approved(id) AS (
   SELECT o.id FROM json_each(?3) p CROSS JOIN object o ON o.id=json_extract(p.value,'$.id')
   WHERE o.cache_id=?1 AND o.nar_id=json_extract(p.value,'$.nar_id')
   AND o.store_path_hash=json_extract(p.value,'$.store_path_hash')
   AND o.created_at=json_extract(p.value,'$.created_at')
   AND o.detached_at IS json_extract(p.value,'$.detached_at')
 ), keep(id) AS (
   SELECT o.id FROM object o WHERE o.cache_id=?1 AND (
     (?3 IS NOT NULL AND o.id NOT IN (SELECT id FROM approved))
     OR julianday(o.created_at)>=julianday(?4)
     OR o.store_path_hash IN (SELECT store_path_hash FROM gc_root WHERE cache_id=?1))
   UNION SELECT child.id FROM keep k CROSS JOIN object parent ON parent.id=k.id
     CROSS JOIN json_each(parent.refs) j
     CROSS JOIN object child ON child.cache_id=?1 AND child.store_path_hash=substr(j.value,1,32)
 ), eligible(id) AS (SELECT id FROM affected EXCEPT SELECT id FROM keep)
`;

function params(
	cacheId: number,
	references: string[],
	targets: PurgeTarget[] | null,
	autoDays: number | null
) {
	if (autoDays !== null && (!Number.isInteger(autoDays) || autoDays < 1 || autoDays > 3650))
		throw new Error('Invalid automatic purge policy');
	return [
		cacheId,
		JSON.stringify(references),
		targets === null
			? null
			: JSON.stringify(
					targets.map(({ id, nar_id, store_path_hash, created_at, detached_at }) => ({
						id,
						nar_id,
						store_path_hash,
						created_at,
						detached_at
					}))
				),
		new Date(
			Date.now() - Math.max(INTEGRITY_PUSH_GRACE_MS, (autoDays ?? 0) * 86400_000)
		).toISOString(),
		autoDays
	];
}

export async function purgePlan(
	db: D1,
	cacheId: number,
	references: string[],
	after = 0,
	autoDays: number | null = null
) {
	if (references.length === 0) return { objects: [] as PurgeTarget[], next_cursor: null };
	const { results } = await dbAll<PurgeTarget>(
		db
			.prepare(
				PURGE_CTES +
					`
 SELECT o.id,o.store_path_hash,o.store_path,o.nar_id,o.created_at,o.detached_at,
 CASE WHEN o.id IN (SELECT id FROM keep) THEN 1 ELSE 0 END AS blocked
 FROM object o JOIN affected a ON a.id=o.id WHERE o.id>?6
 AND (?5 IS NULL OR o.id IN (SELECT id FROM eligible)) ORDER BY o.id LIMIT 501
 `
			)
			.bind(...params(cacheId, references, null, autoDays), after)
	);
	return {
		objects: results.slice(0, 500),
		next_cursor: results.length > 500 ? results[499].id : null
	};
}

/** Journal and all metadata deletion commit together. An idempotency receipt
 * survives response loss; retries cannot delete an expanded or re-pushed plan. */
export async function applyPurge(
	env: Env,
	ctx: ExecutionContext | undefined,
	cacheId: number,
	cacheName: string,
	references: string[],
	targets: PurgeTarget[],
	id: string,
	autoDays: number | null = null
) {
	const db = env.ATTIC_DB;
	const prior = await dbFirst<Operation>(
		db.prepare('SELECT * FROM path_purge WHERE id=?1').bind(id)
	);
	if (prior && prior.cache_id !== cacheId)
		throw new Error('Purge operation belongs to another cache');
	if (!prior) {
		// The receipt is also the transaction's eligibility snapshot. Deletions
		// use these IDs, avoiding three graph traversals/index builds. It only
		// records eligible objects, so retained paths need no edge invalidation.
		const eligible = `SELECT json_extract(j.value,'$.id') FROM path_purge p,json_each(p.objects) j
      WHERE p.id=?1 AND p.cache_id=?2 AND p.state='pending'`;
		await dbBatch(db, [
			db
				.prepare(
					PURGE_CTES +
						`INSERT OR IGNORE INTO path_purge (id,cache_id,cache_name,objects,created_at)
          SELECT ?6,?1,?7,json_group_array(json_object('id',o.id,'hash',o.store_path_hash,'nar_hash',n.nar_hash)),?8
          FROM eligible e CROSS JOIN object o ON o.id=e.id LEFT JOIN nar n ON n.id=o.nar_id`
				)
				.bind(
					...params(cacheId, references, targets, autoDays),
					id,
					cacheName,
					new Date().toISOString()
				),
			db
				.prepare(`UPDATE object_ref SET child_id=NULL WHERE child_id IN (${eligible})`)
				.bind(id, cacheId),
			db.prepare(`DELETE FROM object_ref WHERE object_id IN (${eligible})`).bind(id, cacheId),
			db.prepare(`DELETE FROM object WHERE id IN (${eligible})`).bind(id, cacheId),
			db
				.prepare(
					`UPDATE path_purge SET removed=changes(),state='deleted' WHERE id=?1 AND state='pending'`
				)
				.bind(id)
		]);
	}
	const confirmed = await finishPurgeOperation(env, ctx, id);
	const operation = await dbFirst<Operation>(
		db.prepare('SELECT * FROM path_purge WHERE id=?1').bind(id)
	);
	return { removed: operation!.removed, pending_purge: !confirmed };
}

async function finishPurgeOperation(
	env: Env,
	ctx: ExecutionContext | undefined,
	id: string
): Promise<boolean> {
	try {
		const store = ctx?.exports?.CachedStore;
		return (
			(await processPathPurge(env, id, async (tags, receipt) => {
				if (store?.purgePathPage) return store.purgePathPage(id, receipt, tags);
				if (!store) return false;
				await store.purgeTags(tags);
			})) === null
		);
	} catch (error) {
		console.warn('path purge invalidation pending', { operationId: id, error });
		return false;
	}
}

/** The coordinator resumes this cursor from its alarm after each confirmed
 * page eviction. Receipts make a lost cursor-update response replayable. */
export async function processPathPurge(
	env: Env,
	id: string,
	purge: (tags: string[], receipt: string) => Promise<void | boolean>
): Promise<number | null> {
	const job = await dbFirst<Operation>(
		env.ATTIC_DB.prepare('SELECT * FROM path_purge WHERE id=?1').bind(id)
	);
	if (!job || job.state === 'done') return null;
	const tags = new Set<string>();
	for (const obj of JSON.parse(job.objects) as JournalObject[]) {
		tags.add(narinfoTag(job.cache_name, obj.hash));
		tags.add(narinfoTag(ROOT_UPSTREAM_TAG_NS, obj.hash));
		tags.add(candidateTag('path', obj.hash));
		if (obj.nar_hash) tags.add(candidateTag('nar', obj.nar_hash));
	}
	const unique = [...tags];
	let cursor = job.tag_cursor;
	for (let page = 0; cursor < unique.length && page < 10; page++) {
		if ((await purge(unique.slice(cursor, cursor + PURGE_TAG_LIMIT), String(cursor))) === false)
			return Date.now() + PURGE_INTERVAL_MS;
		cursor = Math.min(cursor + PURGE_TAG_LIMIT, unique.length);
		await dbRun(
			env.ATTIC_DB.prepare('UPDATE path_purge SET tag_cursor=MAX(tag_cursor,?2) WHERE id=?1').bind(
				id,
				cursor
			)
		);
	}
	if (cursor === unique.length) {
		await dbRun(
			env.ATTIC_DB.prepare("UPDATE path_purge SET state='done',objects='[]' WHERE id=?1").bind(id)
		);
		return null;
	}
	return Date.now() + PURGE_INTERVAL_MS;
}

export async function replayPathPurges(env: Env, ctx?: ExecutionContext, cacheId?: number) {
	const rows = await dbAll<{ id: string }>(
		env.ATTIC_DB.prepare(
			"SELECT id FROM path_purge WHERE state='deleted' AND (?1 IS NULL OR cache_id=?1) ORDER BY created_at LIMIT 10"
		).bind(cacheId ?? null)
	);
	for (const row of rows.results) await finishPurgeOperation(env, ctx, row.id);
	const remaining = await dbFirst<{ pending: number }>(
		env.ATTIC_DB.prepare(
			"SELECT COUNT(*) AS pending FROM path_purge WHERE state='deleted' AND (?1 IS NULL OR cache_id=?1)"
		).bind(cacheId ?? null)
	);
	return { pending: remaining?.pending ?? 0 };
}
