// Maintenance reads over the reference graph recorded by GC. Check actual
// object rows as well as child_id: a repair push is visible before ref-sync.
import { dbAll } from './db';
import { upstreamTtlSecs, type Upstream } from './missing-paths';

type D1 = App.Platform['env']['ATTIC_DB'];
const PAGE_SIZE = 100;
/** Sized to outlast a real push that spans the nightly run. */
export const INTEGRITY_PUSH_GRACE_MS = 6 * 3600_000;

export async function uncoveredReferences(
	db: D1,
	cacheId: number,
	upstreams: Upstream[],
	after = ''
) {
	const coverage = upstreams.map((u) => ({
		id: u.id,
		cutoff: new Date(Date.now() - upstreamTtlSecs(u) * 1000).toISOString()
	}));
	const { results } = await dbAll<{ hash: string; name: string; referrers: number }>(
		db
			.prepare(
				// Preserve the ref_hash range scan and grouping order so LIMIT can
				// stop early. D1 otherwise scans all NULL child_ids and sorts the
				// whole graph again for each page (1.5M rows on the live instance).
				`WITH uncovered AS (
			 SELECT r.ref_hash, MIN(r.object_id) AS parent_id, COUNT(*) AS referrers
			 FROM object_ref r INDEXED BY idx_object_ref_ref_hash CROSS JOIN object o ON o.id = r.object_id
			 WHERE r.child_id IS NULL AND o.cache_id = ?1 AND o.detached_at IS NULL
			 AND r.ref_hash > ?2 AND o.created_at < ?3
			 AND NOT EXISTS (SELECT 1 FROM object child JOIN nar n ON n.id = child.nar_id
			   WHERE child.cache_id = ?1 AND child.store_path_hash = r.ref_hash AND n.state = 'V')
			 AND NOT EXISTS (SELECT 1 FROM upstream_check uc JOIN json_each(?4) u
			   ON uc.upstream_id = json_extract(u.value, '$.id')
			   WHERE uc.store_path_hash = r.ref_hash AND uc.present <> 0
			   AND uc.checked_at >= json_extract(u.value, '$.cutoff'))
			 GROUP BY r.ref_hash ORDER BY r.ref_hash LIMIT ${PAGE_SIZE + 1}
			)
			SELECT u.ref_hash AS hash, MIN(j.value) AS name, u.referrers
			FROM uncovered u JOIN object o ON o.id = u.parent_id JOIN json_each(o.refs) j
			ON substr(j.value, 1, 32) = u.ref_hash
			GROUP BY u.ref_hash ORDER BY u.ref_hash`
			)
			.bind(
				cacheId,
				after,
				new Date(Date.now() - INTEGRITY_PUSH_GRACE_MS).toISOString(),
				JSON.stringify(coverage)
			)
	);
	const references = results.slice(0, PAGE_SIZE).map(({ hash, name, referrers }) => ({
		hash,
		store_path: `/nix/store/${name}`,
		referrers
	}));
	return {
		references,
		next_cursor: results.length > PAGE_SIZE ? references.at(-1)!.hash : null
	};
}
