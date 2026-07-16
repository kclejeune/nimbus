import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { loadTraffic } from '$lib/server/traffic';
import type { PageServerLoad } from './$types';

interface BucketRow {
	bucket: string;
	paths: number;
	bytes: number;
}

export type Granularity = 'day' | 'week' | 'month';
export type RangeKey = '30d' | '90d' | '6m' | '1y' | 'all';

export interface Bucket {
	/** ISO date of the bucket start (day, Monday of week, or first of month). */
	date: string;
	paths: number;
	/** Bytes added in this bucket. */
	bytes: number;
	/** Cumulative paths through this bucket (includes pre-range baseline). */
	cumulativePaths: number;
	/** Cumulative bytes through this bucket (includes pre-range baseline). */
	cumulativeBytes: number;
}

function parseGranularity(v: string | null): Granularity {
	return v === 'day' || v === 'month' ? v : 'week';
}

function parseRange(v: string | null): RangeKey {
	return v === '30d' || v === '90d' || v === '6m' || v === '1y' ? v : 'all';
}

const DAY_MS = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Align an epoch-ms to the start of its day / week (Monday) / month, in UTC. */
function bucketStart(ms: number, g: Granularity): number {
	const d = new Date(ms);
	if (g === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	if (g === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
	const daysSinceMonday = (d.getUTCDay() + 6) % 7;
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

function nextBucket(ms: number, g: Granularity): number {
	if (g === 'day') return ms + DAY_MS;
	if (g === 'week') return ms + 7 * DAY_MS;
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Start of the range window (epoch-ms), or null for "all time". */
function rangeStart(range: RangeKey, nowMs: number): number | null {
	const d = new Date(nowMs);
	switch (range) {
		case '30d':
			return nowMs - 30 * DAY_MS;
		case '90d':
			return nowMs - 90 * DAY_MS;
		case '6m':
			return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, d.getUTCDate());
		case '1y':
			return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12, d.getUTCDate());
		default:
			return null;
	}
}

/** SQL expression that maps o.created_at to its bucket-start date string. */
function bucketExpr(g: Granularity): string {
	if (g === 'day') return 'date(o.created_at)';
	if (g === 'month') return "strftime('%Y-%m-01', o.created_at)";
	return "date(o.created_at, '-' || ((cast(strftime('%w', o.created_at) AS INTEGER) + 6) % 7) || ' days')";
}

const NAR_BYTES_JOIN = `FROM object o
	 JOIN nar n ON n.id = o.nar_id
	 JOIN chunkref cr ON cr.nar_id = n.id
	 JOIN chunk ch ON ch.id = cr.chunk_id`;

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = platform?.env.ATTIC_DB;
	const granularity = parseGranularity(url.searchParams.get('granularity'));
	const range = parseRange(url.searchParams.get('range'));

	// Local preview without bindings: synthesize a plausible series.
	if (!db) {
		if (!dev) throw error(500, 'Database binding unavailable');
		return { buckets: sampleBuckets(granularity), granularity, range, traffic: null };
	}

	// Config-gated (returns null when unconfigured); runs alongside the D1 work.
	const trafficPromise = platform?.env ? loadTraffic(platform.env) : Promise.resolve(null);

	const now = Date.now();
	const startMs = rangeStart(range, now);
	const startDate = startMs === null ? null : iso(bucketStart(startMs, granularity));

	// The bucketed series and the pre-range baseline are independent — run them
	// together.
	const seriesStmt = startDate
		? db
				.prepare(
					`SELECT ${bucketExpr(granularity)} AS bucket, COUNT(*) AS paths,
					        COALESCE(SUM(ch.file_size), 0) AS bytes
					 ${NAR_BYTES_JOIN}
					 WHERE o.created_at >= ?1
					 GROUP BY bucket ORDER BY bucket`
				)
				.bind(startDate)
		: db.prepare(
				`SELECT ${bucketExpr(granularity)} AS bucket, COUNT(*) AS paths,
				        COALESCE(SUM(ch.file_size), 0) AS bytes
				 ${NAR_BYTES_JOIN}
				 GROUP BY bucket ORDER BY bucket`
			);
	// Cumulative series should include everything added before the range starts.
	const baselineStmt = startDate
		? db
				.prepare(
					`SELECT COUNT(*) AS paths, COALESCE(SUM(ch.file_size), 0) AS bytes ${NAR_BYTES_JOIN} WHERE o.created_at < ?1`
				)
				.bind(startDate)
		: null;

	const [seriesResult, baselineRow] = await Promise.all([
		seriesStmt.all<BucketRow>(),
		baselineStmt ? baselineStmt.first<{ paths: number; bytes: number }>() : Promise.resolve(null)
	]);

	const rows = seriesResult.results;
	const basePaths = baselineRow?.paths ?? 0;
	const baseBytes = baselineRow?.bytes ?? 0;

	// Nothing ever pushed and no window to draw → empty state.
	if (rows.length === 0 && startDate === null) {
		return { buckets: [], granularity, range, traffic: await trafficPromise };
	}

	const byBucket = new Map(rows.map((r) => [r.bucket, r]));
	const firstMs =
		startDate !== null
			? bucketStart(startMs!, granularity)
			: bucketStart(Date.parse(`${rows[0].bucket}T00:00:00Z`), granularity);
	const endMs = bucketStart(now, granularity);

	const buckets: Bucket[] = [];
	let cumPaths = basePaths;
	let cumBytes = baseBytes;
	for (let ms = firstMs, i = 0; ms <= endMs && i < 800; ms = nextBucket(ms, granularity), i++) {
		const key = iso(ms);
		const row = byBucket.get(key);
		const paths = row?.paths ?? 0;
		const bytes = row?.bytes ?? 0;
		cumPaths += paths;
		cumBytes += bytes;
		buckets.push({
			date: key,
			paths,
			bytes,
			cumulativePaths: cumPaths,
			cumulativeBytes: cumBytes
		});
	}

	return { buckets, granularity, range, traffic: await trafficPromise };
};

function sampleBuckets(granularity: Granularity): Bucket[] {
	const out: Bucket[] = [];
	let cumPaths = 0;
	let cumBytes = 0;
	const step = granularity === 'day' ? DAY_MS : granularity === 'month' ? 30 * DAY_MS : 7 * DAY_MS;
	const start = Date.UTC(2026, 0, 5);
	for (let i = 0; i < 20; i++) {
		const paths = Math.round(20 + 60 * Math.abs(Math.sin(i / 2)) + (i % 3) * 12);
		const bytes = paths * (4_000_000 + (i % 4) * 1_500_000);
		cumPaths += paths;
		cumBytes += bytes;
		out.push({
			date: iso(start + i * step),
			paths,
			bytes,
			cumulativePaths: cumPaths,
			cumulativeBytes: cumBytes
		});
	}
	return out;
}
