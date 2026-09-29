// SQL for the usage page's performance views, over the Analytics Engine
// dataset cache/metrics.ts and cache/latency.ts write. Pure (no I/O) so the
// shapes are testable; load.ts runs them.
//
// Latency points (blob1 = 'latency'), per cache/latency.ts observeRequest:
//   blob2 layer ('gateway' | 'store'), blob3 route template, blob4
//   CF-Cache-Status, blob5 colo, blob6 HTTP status, blob7 D1 region (rows
//   before it existed read '').
//   double1 sampling weight, double2 header latency ms, double3 D1
//   statements, double4 rows read, double5 rows written, double6 R2 ops,
//   double8 response bytes (-1 unknown), double9..15 stage ms (auth,
//   candidates, store, upstream, admission, d1, r2), double16 D1 statements
//   served by the primary, double19 D1 SQL ms.
//
// Every point stands for `_sample_interval * double1` events: AE's own
// ingest sampling times the client-side read sampling. Counts sum that
// weight; quantiles weight by it (as an integer, which the function needs).
//
// Requests are counted at the gateway only: a gateway request that loops
// back into CachedStore writes a second, store-layer point for the same
// client request. Work (D1, R2, rows) is summed across both layers, since
// each invocation records only its own.

export const DATASET = 'nimbus_cache_metrics';

export type WindowKey = '1h' | '24h' | '7d' | '30d';

export interface WindowSpec {
	key: WindowKey;
	label: string;
	/** SQL interval literal for `NOW() - INTERVAL …`. */
	interval: string;
	/** AE time-bucketing function. */
	bucketFn: string;
	/** Bucket width, for rates and zero-fill. */
	stepSeconds: number;
	buckets: number;
}

export const WINDOWS: Record<WindowKey, WindowSpec> = {
	'1h': {
		key: '1h',
		label: 'Last hour',
		interval: "'1' HOUR",
		bucketFn: 'toStartOfMinute',
		stepSeconds: 60,
		buckets: 60
	},
	'24h': {
		key: '24h',
		label: 'Last 24 hours',
		interval: "'24' HOUR",
		bucketFn: 'toStartOfFifteenMinutes',
		stepSeconds: 900,
		buckets: 96
	},
	'7d': {
		key: '7d',
		label: 'Last 7 days',
		interval: "'7' DAY",
		bucketFn: 'toStartOfHour',
		stepSeconds: 3600,
		buckets: 168
	},
	'30d': {
		key: '30d',
		label: 'Last 30 days',
		interval: "'30' DAY",
		bucketFn: 'toStartOfDay',
		stepSeconds: 86400,
		buckets: 30
	}
};

export function parseWindow(raw: string | null): WindowKey {
	return raw === '1h' || raw === '7d' || raw === '30d' ? raw : '24h';
}

const W = '_sample_interval * double1';
const WI = `toUInt32(${W})`;
const STATUS = 'toUInt32(blob6)';
const EDGE_HIT = "blob4 IN ('HIT', 'STALE', 'UPDATING')";
const EDGE_ORIGIN = "blob4 IN ('MISS', 'EXPIRED', 'REVALIDATED')";

/** Aggregates shared by every latency query. */
const LATENCY_COLUMNS = `
	SUM(${W}) AS n,
	sumIf(${W}, ${STATUS} >= 500) AS e5,
	sumIf(${W}, ${STATUS} >= 400 AND ${STATUS} < 500) AS e4,
	sumIf(${W}, ${EDGE_HIT}) AS edge_hit,
	sumIf(${W}, ${EDGE_ORIGIN}) AS edge_origin,
	quantileExactWeighted(0.5)(double2, ${WI}) AS p50,
	quantileExactWeighted(0.95)(double2, ${WI}) AS p95,
	quantileExactWeighted(0.99)(double2, ${WI}) AS p99,
	SUM(${W} * double3) AS d1,
	SUM(${W} * double16) AS d1_primary,
	SUM(${W} * double4) AS rows_read,
	SUM(${W} * double5) AS rows_written,
	SUM(${W} * double6) AS r2,
	SUM(${W} * double19) AS d1_sql_ms`;

function latencyWhere(w: WindowSpec, extra = ''): string {
	return `WHERE blob1 = 'latency' AND timestamp > NOW() - INTERVAL ${w.interval}${extra}`;
}

export interface Queries {
	/** Per bucket and layer. */
	series: string;
	/** Whole-window per layer (quantiles don't combine across buckets). */
	overall: string;
	/** Per layer and route, busiest first. */
	routes: string;
	/** Gateway latency by edge-cache verdict. */
	edge: string;
	/** Gateway traffic by Cloudflare colo, busiest first. */
	colos: string;
	/** D1 work by serving region. */
	regions: string;
	/** Non-latency events: reads, pushes, chunk writes, guards, rate limits. */
	events: string;
}

export function buildQueries(w: WindowSpec): Queries {
	return {
		series: `
			SELECT ${w.bucketFn}(timestamp) AS t, blob2 AS layer, ${LATENCY_COLUMNS}
			FROM ${DATASET} ${latencyWhere(w)}
			GROUP BY t, layer ORDER BY t ASC FORMAT JSON`,
		overall: `
			SELECT blob2 AS layer, ${LATENCY_COLUMNS}
			FROM ${DATASET} ${latencyWhere(w)}
			GROUP BY layer FORMAT JSON`,
		routes: `
			SELECT blob2 AS layer, blob3 AS route, ${LATENCY_COLUMNS},
			       SUM(${W} * double2) AS total_ms,
			       SUM(${W} * double9) AS auth_ms,
			       SUM(${W} * double10) AS candidates_ms,
			       SUM(${W} * double11) AS store_ms,
			       SUM(${W} * double12) AS upstream_ms,
			       SUM(${W} * double13) AS admission_ms,
			       SUM(${W} * double14) AS d1_ms,
			       SUM(${W} * double15) AS r2_ms,
			       sumIf(${W} * double8, double8 >= 0) AS bytes,
			       sumIf(${W}, double8 >= 0) AS sized
			FROM ${DATASET} ${latencyWhere(w)}
			GROUP BY layer, route ORDER BY n DESC LIMIT 60 FORMAT JSON`,
		edge: `
			SELECT blob4 AS edge, SUM(${W}) AS n,
			       quantileExactWeighted(0.5)(double2, ${WI}) AS p50,
			       quantileExactWeighted(0.95)(double2, ${WI}) AS p95,
			       quantileExactWeighted(0.99)(double2, ${WI}) AS p99
			FROM ${DATASET} ${latencyWhere(w, " AND blob2 = 'gateway'")}
			GROUP BY edge ORDER BY n DESC FORMAT JSON`,
		colos: `
			SELECT blob5 AS colo, SUM(${W}) AS n,
			       sumIf(${W}, ${EDGE_HIT}) AS edge_hit,
			       sumIf(${W}, ${EDGE_ORIGIN}) AS edge_origin,
			       quantileExactWeighted(0.5)(double2, ${WI}) AS p50,
			       quantileExactWeighted(0.95)(double2, ${WI}) AS p95,
			       quantileExactWeighted(0.99)(double2, ${WI}) AS p99
			FROM ${DATASET} ${latencyWhere(w, " AND blob2 = 'gateway'")}
			GROUP BY colo ORDER BY n DESC LIMIT 15 FORMAT JSON`,
		regions: `
			SELECT blob7 AS region, SUM(${W} * double3) AS d1,
			       SUM(${W} * double16) AS d1_primary, SUM(${W} * double19) AS d1_sql_ms
			FROM ${DATASET} ${latencyWhere(w, " AND blob7 <> '' AND double3 > 0")}
			GROUP BY region ORDER BY d1 DESC LIMIT 12 FORMAT JSON`,
		events: `
			SELECT ${w.bucketFn}(timestamp) AS t, blob1 AS kind, blob2 AS event, blob3 AS label,
			       SUM(${W}) AS n, SUM(${W} * double2) AS bytes
			FROM ${DATASET}
			WHERE blob1 IN ('narinfo', 'nar', 'push', 'chunk', 'guard', 'limit')
			  AND timestamp > NOW() - INTERVAL ${w.interval}
			GROUP BY t, kind, event, label ORDER BY t ASC FORMAT JSON`
	};
}
