// Read-path traffic summary for the monitoring page, queried from the
// Analytics Engine SQL API (the worker-side writer is cache/metrics.ts).
// Querying needs an account-scoped API token, so this whole feature is
// config-gated: loadTraffic returns null — and the UI hides the section —
// unless CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are set.

type Env = App.Platform['env'];

const DATASET = 'nimbus_cache_metrics';
const QUERY_TIMEOUT_MS = 5_000;

export interface TrafficTotals {
	hit: number;
	miss: number;
	upstream: number;
}

export interface TrafficDay extends TrafficTotals {
	/** ISO date (UTC day). */
	date: string;
}

export interface TrafficSummary {
	/** Zero-filled last-30-days series, narinfo + NAR combined. */
	days: TrafficDay[];
	narinfo: TrafficTotals;
	nar: TrafficTotals;
}

interface SqlRow {
	day: string;
	kind: string;
	event: string;
	n: number | string;
}

/** Last 30 days of read-path traffic, or null when unconfigured/unreachable. */
export async function loadTraffic(env: Env): Promise<TrafficSummary | null> {
	if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;

	// _sample_interval sums to the true event count under AE's sampling.
	const sql = `
		SELECT toStartOfDay(timestamp) AS day, blob1 AS kind, blob2 AS event,
		       SUM(_sample_interval) AS n
		FROM ${DATASET}
		WHERE timestamp > NOW() - INTERVAL '30' DAY
		GROUP BY day, kind, event
		ORDER BY day ASC
		FORMAT JSON`;

	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
				body: sql,
				signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
			}
		);
		if (!response.ok) {
			console.warn(`traffic query failed: ${response.status} ${await response.text()}`);
			return null;
		}
		const { data } = (await response.json()) as { data: SqlRow[] };
		return summarize(data);
	} catch (e) {
		console.warn(`traffic query failed: ${e}`);
		return null;
	}
}

function summarize(rows: SqlRow[]): TrafficSummary {
	const zero = (): TrafficTotals => ({ hit: 0, miss: 0, upstream: 0 });
	const narinfo = zero();
	const nar = zero();
	const byDay = new Map<string, TrafficTotals>();

	for (const row of rows) {
		const n = Number(row.n) || 0;
		const event = row.event as keyof TrafficTotals;
		if (!(event in narinfo)) continue; // 'other' stays out of the summary
		const totals = row.kind === 'narinfo' ? narinfo : row.kind === 'nar' ? nar : null;
		if (!totals) continue;
		totals[event] += n;
		const date = row.day.slice(0, 10);
		const day = byDay.get(date) ?? zero();
		day[event] += n;
		byDay.set(date, day);
	}

	// Zero-fill so idle days chart as zero instead of being skipped.
	const days: TrafficDay[] = [];
	const DAY_MS = 86_400_000;
	const start = Date.now() - 29 * DAY_MS;
	for (let i = 0; i < 30; i++) {
		const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
		days.push({ date, ...(byDay.get(date) ?? zero()) });
	}
	return { days, narinfo, nar };
}
