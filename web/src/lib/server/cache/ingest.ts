// Ingest series for the dashboard charts: store paths pushed and the stored
// (compressed, chunk-summed) bytes behind them, bucketed by push date.
//
// The byte sum has to walk object → nar → chunkref → chunk, which yields one
// row per *chunk*. Paths are therefore counted as DISTINCT object ids — a plain
// COUNT(*) counts a chunked NAR (≥ 100 MiB, cut into many chunks) once per
// chunk and inflated the path series many times over.
//
// That walk over the whole store is too heavy per page view, so nightly GC
// rolls it up per day into ingest_day, covering everything created before
// server_config.ingest_rollup_until. Readers union the rollup with the same
// walk over only the paths created since — so the series is exact as of the
// last rollup plus live for the tail, and with no rollup yet (UNTIL = '') the
// tail is simply everything.
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';

export type Granularity = 'day' | 'week' | 'month';

export interface IngestRow {
	/** Bucket start: ISO date of the day, Monday of the week, or first of the month (UTC). */
	bucket: string;
	paths: number;
	bytes: number;
}

type Queryable = Pick<D1Database | D1DatabaseSession, 'prepare'>;

const FROM = `FROM object o
	 JOIN nar n ON n.id = o.nar_id
	 JOIN chunkref cr ON cr.nar_id = n.id
	 JOIN chunk ch ON ch.id = cr.chunk_id`;

const UNTIL_KEY = 'ingest_rollup_until';
/** The rollup's exclusive upper bound (YYYY-MM-DD), '' before the first one. */
const UNTIL = `COALESCE((SELECT value FROM server_config WHERE key = '${UNTIL_KEY}'), '')`;

/**
 * Per-day paths and bytes from both sources, optionally bounded by
 * `day >= ?1` or `day < ?1`. The tail's `cache_id IN (…)` lets the
 * (cache_id, created_at) index range-scan each cache instead of the table.
 */
function days(bound: '' | '>=' | '<'): string {
	const rollupBound = bound ? `AND day ${bound} ?1` : '';
	const tailBound = bound ? `AND o.created_at ${bound} ?1` : '';
	return `SELECT day, paths, bytes FROM ingest_day WHERE day < ${UNTIL} ${rollupBound}
	 UNION ALL
	 SELECT date(o.created_at) AS day, COUNT(DISTINCT o.id) AS paths,
	        COALESCE(SUM(ch.file_size), 0) AS bytes
	 ${FROM}
	 WHERE o.cache_id IN (SELECT id FROM cache) AND o.created_at >= ${UNTIL} ${tailBound}
	 GROUP BY day`;
}

/** SQL expression mapping a YYYY-MM-DD `day` to its bucket-start date string. */
function bucketExpr(g: Granularity): string {
	if (g === 'day') return 'day';
	if (g === 'month') return "strftime('%Y-%m-01', day)";
	return "date(day, '-' || ((cast(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days')";
}

/** Paths and bytes per bucket, from `since` (ISO date, inclusive) or all time. */
export async function ingestSeries(
	db: Queryable,
	granularity: Granularity,
	since: string | null
): Promise<IngestRow[]> {
	const sql = `SELECT ${bucketExpr(granularity)} AS bucket, SUM(paths) AS paths, SUM(bytes) AS bytes
	 FROM (${days(since ? '>=' : '')})
	 GROUP BY bucket ORDER BY bucket`;
	const stmt = since ? db.prepare(sql).bind(since) : db.prepare(sql);
	return (await stmt.all<IngestRow>()).results;
}

/** Paths and bytes pushed before `before` (ISO date), the cumulative series' baseline. */
export async function ingestBaseline(
	db: Queryable,
	before: string
): Promise<{ paths: number; bytes: number }> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(paths), 0) AS paths, COALESCE(SUM(bytes), 0) AS bytes
			 FROM (${days('<')})`
		)
		.bind(before)
		.first<{ paths: number; bytes: number }>();
	return { paths: row?.paths ?? 0, bytes: row?.bytes ?? 0 };
}

/**
 * Rebuild the rollup through the end of yesterday (UTC), atomically with its
 * bound. Nightly, from GC on the primary: it measures the store as the sweep
 * left it, so paths reaped since the previous run drop out of the history
 * just as they did from the old per-view aggregate. Writes ~one row per day
 * of history (no secondary index), which is why this is a whole rebuild
 * rather than incremental bookkeeping on the push path.
 */
export async function refreshIngestRollup(db: D1Database, now = new Date()): Promise<void> {
	const until = now.toISOString().slice(0, 10);
	await db.batch([
		db.prepare('DELETE FROM ingest_day'),
		db
			.prepare(
				`INSERT INTO ingest_day (day, paths, bytes)
				 SELECT date(o.created_at), COUNT(DISTINCT o.id), COALESCE(SUM(ch.file_size), 0)
				 ${FROM}
				 WHERE o.created_at < ?1
				 GROUP BY 1`
			)
			.bind(until),
		db
			.prepare(
				`INSERT INTO server_config (key, value) VALUES ('${UNTIL_KEY}', ?1)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
			)
			.bind(until)
	]);
}
