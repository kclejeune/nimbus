// Opt-in nightly cleanup. A confirmation clock is independent of object age;
// old uploads are never immediately eligible when the policy is enabled.
import { dbAll, dbBatch, dbFirst, dbRun } from './db';
import { checkReferences, uncoveredReferences } from './closure-repair';
import { applyPurge, purgePlan, readPurgeUpstreams } from './closure-purge';
import type { ExecutionContext } from './platform';

type Env = App.Platform['env'];
type State = {
	policy_days: number;
	upstream_config: string;
	after_hash: string;
	purge_after_hash: string;
};
const MAX_REFERENCES = 64;
const MAX_LIVE_PROBES = 200;
const MAX_PLAN_QUERIES = 4;
const MAX_REMOVALS = 500;
const WALL_BUDGET_MS = 60_000;

/** One enabled cache per invocation, oldest-run first. Bounded discovery and
 * oldest-checked observations share the probe budget, so existing failures
 * cannot permanently starve unseen references. Cursors wrap across nights. */
export async function runBrokenClosureGc(env: Env, ctx?: ExecutionContext) {
	const stats = {
		automatic_refs_checked: 0,
		automatic_refs_waiting: 0,
		automatic_objects_removed: 0,
		automatic_purge_deferred: 0,
		automatic_purge_pending: 0,
		automatic_purge_errors: 0
	};
	const db = env.ATTIC_DB;
	const cache = await dbFirst<{ id: number; name: string; days: number }>(
		db.prepare(
			`SELECT c.id,c.name,c.purge_broken_after_days AS days FROM cache c
     LEFT JOIN broken_purge_state s ON s.cache_id=c.id
     WHERE c.deleted_at IS NULL AND c.purge_broken_after_days IS NOT NULL
     ORDER BY COALESCE(s.last_run_at,''),c.id LIMIT 1`
		)
	);
	if (!cache) return stats;
	const started = Date.now(),
		now = new Date(started).toISOString();
	try {
		const { config, upstreams } = await readPurgeUpstreams(db, cache.id, cache.name);
		await dbBatch(db, [
			db
				.prepare(
					`DELETE FROM broken_reference WHERE cache_id=?1 AND NOT EXISTS (
       SELECT 1 FROM broken_purge_state WHERE cache_id=?1 AND policy_days=?2 AND upstream_config=?3)`
				)
				.bind(cache.id, cache.days, config),
			db
				.prepare(
					`INSERT INTO broken_purge_state(cache_id,policy_days,upstream_config,last_run_at)
       SELECT ?1,?2,?3,?4 WHERE EXISTS (SELECT 1 FROM cache WHERE id=?1 AND deleted_at IS NULL AND purge_broken_after_days=?2)
       ON CONFLICT(cache_id) DO UPDATE SET
       after_hash=CASE WHEN policy_days=excluded.policy_days AND upstream_config=excluded.upstream_config THEN after_hash ELSE '' END,
       purge_after_hash=CASE WHEN policy_days=excluded.policy_days AND upstream_config=excluded.upstream_config THEN purge_after_hash ELSE '' END,
       policy_days=excluded.policy_days,upstream_config=excluded.upstream_config,last_run_at=excluded.last_run_at`
				)
				.bind(cache.id, cache.days, config, now)
		]);
		const state = await dbFirst<State>(
			db.prepare('SELECT * FROM broken_purge_state WHERE cache_id=?1').bind(cache.id)
		);
		if (!state || state.policy_days !== cache.days || state.upstream_config !== config)
			return stats;
		if (upstreams.length > MAX_LIVE_PROBES) {
			stats.automatic_purge_deferred++;
			return stats;
		}
		const limit = Math.min(
			MAX_REFERENCES,
			Math.max(1, Math.floor(MAX_LIVE_PROBES / Math.max(1, upstreams.length)))
		);
		const tracked = await dbAll<{ ref_hash: string }>(
			db
				.prepare(
					'SELECT ref_hash FROM broken_reference WHERE cache_id=?1 ORDER BY last_checked_at,ref_hash LIMIT ?2'
				)
				.bind(cache.id, Math.floor(limit / 2))
		);
		const page = await uncoveredReferences(
			db,
			cache.id,
			upstreams,
			state.after_hash,
			Math.ceil(limit / 2)
		);
		const hashes = [
			...new Set([...tracked.results.map((r) => r.ref_hash), ...page.references.map((r) => r.hash)])
		];
		// Freshly verify cached misses. Positive or unknown results reset the
		// clock; neither is evidence authorizing destructive maintenance.
		const checked = await checkReferences(db, cache.name, upstreams, hashes, undefined, true);
		stats.automatic_refs_checked = hashes.length;
		await dbBatch(db, [
			db
				.prepare(
					`DELETE FROM broken_reference WHERE cache_id=?1
       AND ref_hash IN (SELECT value FROM json_each(?2)) AND ref_hash NOT IN (SELECT value FROM json_each(?3))`
				)
				.bind(cache.id, JSON.stringify(hashes), JSON.stringify(checked.missing)),
			db
				.prepare(
					`INSERT INTO broken_reference(cache_id,ref_hash,upstream_config,first_missing_at,last_checked_at)
       SELECT ?1,value,?2,?3,?3 FROM json_each(?4) WHERE EXISTS (
         SELECT 1 FROM cache c JOIN broken_purge_state s ON s.cache_id=c.id
         WHERE c.id=?1 AND c.deleted_at IS NULL AND c.purge_broken_after_days=?5 AND s.policy_days=?5 AND s.upstream_config=?2)
       ON CONFLICT(cache_id,ref_hash) DO UPDATE SET
       first_missing_at=CASE WHEN upstream_config=excluded.upstream_config THEN first_missing_at ELSE excluded.first_missing_at END,
       upstream_config=excluded.upstream_config,last_checked_at=excluded.last_checked_at`
				)
				.bind(cache.id, config, now, JSON.stringify(checked.missing), cache.days),
			db
				.prepare(
					`DELETE FROM broken_reference WHERE cache_id=?1 AND ref_hash IN (SELECT value FROM json_each(?2))
       AND NOT EXISTS (SELECT 1 FROM object_ref r JOIN object o ON o.id=r.object_id
       WHERE r.ref_hash=broken_reference.ref_hash AND o.cache_id=?1 AND o.detached_at IS NULL)`
				)
				.bind(cache.id, JSON.stringify(hashes)),
			db
				.prepare(
					`UPDATE broken_purge_state SET after_hash=?2 WHERE cache_id=?1 AND policy_days=?3 AND upstream_config=?4`
				)
				.bind(cache.id, page.next_cursor ?? '', cache.days, config)
		]);
		const observed = await dbAll<{ ref_hash: string; ready: number }>(
			db
				.prepare(
					`SELECT ref_hash,julianday(first_missing_at)<=julianday('now')-?4 AS ready FROM broken_reference
     WHERE cache_id=?1 AND upstream_config=?2 AND ref_hash IN (SELECT value FROM json_each(?3))
	     ORDER BY ref_hash`
				)
				.bind(cache.id, config, JSON.stringify(checked.missing), cache.days)
		);
		const due = observed.results.filter((r) => r.ready);
		stats.automatic_refs_waiting = observed.results.length - due.length;
		// Plan one dependency's entire affected closure at a time. Splitting a
		// combined plan can spend every query on oversized ancestors each night.
		// Rotate independently of discovery, including past oversized closures,
		// so neither they nor the query cap can starve later actionable groups.
		const queue = [
			...due.filter((r) => r.ref_hash > state.purge_after_hash),
			...due.filter((r) => r.ref_hash <= state.purge_after_hash)
		].map((r) => [r.ref_hash]);
		let purgeAfter = state.purge_after_hash;
		let plans = 0,
			remaining = MAX_REMOVALS;
		while (
			queue.length &&
			plans < MAX_PLAN_QUERIES &&
			remaining > 0 &&
			Date.now() - started < WALL_BUDGET_MS
		) {
			const references = queue.shift()!;
			plans++;
			// The automatic plan excludes protected paths, bounding results even
			// when a large pinned closure shares the missing dependency.
			const plan = await purgePlan(db, cache.id, references, 0, cache.days);
			purgeAfter = references[0];
			if (plan.next_cursor !== null || plan.objects.length > remaining) {
				stats.automatic_purge_deferred++;
				if (plan.next_cursor !== null || plan.objects.length > MAX_REMOVALS) {
					console.warn(
						'gc: automatic purge exceeds batch cap; use nimbus purge for a reviewed plan',
						{ cache: cache.name, reference: references[0] }
					);
				}
				continue;
			}
			if (!plan.objects.length) continue;
			if (Date.now() - started >= WALL_BUDGET_MS) {
				queue.push(references);
				break;
			}
			// Policy, confirmation age, current upstream configuration, pins,
			// publication age and object versions are checked again atomically.
			const operationId = crypto.randomUUID();
			const result = await applyPurge(
				env,
				ctx,
				cache.id,
				cache.name,
				references,
				plan.objects,
				operationId,
				cache.days
			);
			console.log('gc: automatic broken-closure purge', {
				cache: cache.name,
				operationId,
				references: references.length,
				reviewed: plan.objects.length,
				removed: result.removed,
				pendingPurge: result.pending_purge
			});
			remaining -= plan.objects.length;
			stats.automatic_objects_removed += result.removed;
			if (result.pending_purge) stats.automatic_purge_pending++;
		}
		if (plans) {
			await dbRun(
				db
					.prepare(
						'UPDATE broken_purge_state SET purge_after_hash=?2 WHERE cache_id=?1 AND policy_days=?3 AND upstream_config=?4'
					)
					.bind(cache.id, purgeAfter, cache.days, config)
			);
		}
		stats.automatic_purge_deferred += queue.length;
	} catch (error) {
		stats.automatic_purge_errors++;
		console.warn('gc: automatic broken-closure pass failed', { cache: cache.name, error });
	}
	return stats;
}
