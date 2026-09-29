// Ingest series for the dashboard charts: store paths pushed and the stored
// (compressed, chunk-summed) bytes behind them, bucketed by push date.
//
// The byte sum has to walk object → nar → chunkref → chunk, which yields one
// row per *chunk*. Paths are therefore counted as DISTINCT object ids — a plain
// COUNT(*) counts a chunked NAR (≥ 100 MiB, cut into many chunks) once per
// chunk and inflated the path series many times over.
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

/** SQL expression mapping o.created_at to its bucket-start date string. */
function bucketExpr(g: Granularity): string {
	if (g === 'day') return 'date(o.created_at)';
	if (g === 'month') return "strftime('%Y-%m-01', o.created_at)";
	return "date(o.created_at, '-' || ((cast(strftime('%w', o.created_at) AS INTEGER) + 6) % 7) || ' days')";
}

/** Paths and bytes per bucket, from `since` (ISO date, inclusive) or all time. */
export async function ingestSeries(
	db: Queryable,
	granularity: Granularity,
	since: string | null
): Promise<IngestRow[]> {
	const sql = `SELECT ${bucketExpr(granularity)} AS bucket, COUNT(DISTINCT o.id) AS paths,
	        COALESCE(SUM(ch.file_size), 0) AS bytes
	 ${FROM}
	 ${since ? 'WHERE o.created_at >= ?1' : ''}
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
			`SELECT COUNT(DISTINCT o.id) AS paths, COALESCE(SUM(ch.file_size), 0) AS bytes
			 ${FROM} WHERE o.created_at < ?1`
		)
		.bind(before)
		.first<{ paths: number; bytes: number }>();
	return { paths: row?.paths ?? 0, bytes: row?.bytes ?? 0 };
}
