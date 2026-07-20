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

/** Edge-cache verdicts across all gateway reads (narinfo + NAR): `hit` was
 *  served from the edge cache, `origin` ran CachedStore (D1/R2), `other` is
 *  everything that never had a cacheable store fetch (uncacheable errors,
 *  memo short-circuits, redirects, pre-edge-metric rows). */
export interface EdgeTotals {
	hit: number;
	origin: number;
	other: number;
}

export interface EdgeDay {
	/** ISO date (UTC day). */
	date: string;
	hit: number;
}

export interface PushTotals {
	/** Paths pushed with a fresh NAR upload. */
	stored: number;
	/** Paths pushed by reusing an already-stored NAR. */
	deduplicated: number;
	/** Logical NAR bytes across both, matching the storage charts' unit. */
	bytes: number;
}

export interface PushDay extends PushTotals {
	/** ISO date (UTC day). */
	date: string;
}

/** Chunk-level storage writes (includes pull-through, unlike push totals).
 *  `storedBytes` is compressed bytes actually written to R2 (each `stored`
 *  event is one R2 Class A op); `dedupBytes` is bytes avoided by chunk reuse. */
export interface StoreWriteTotals {
	stored: number;
	deduplicated: number;
	storedBytes: number;
	dedupBytes: number;
}

export interface StoreWriteDay {
	/** ISO date (UTC day). */
	date: string;
	stored: number;
	storedBytes: number;
}

/** Abuse-guard refusals: upstream probes, absent-verdict writes, and
 *  pull-through ingests deflected by their rate budgets. */
export interface GuardTotals {
	probe: number;
	verdict: number;
	ingest: number;
}

export interface TrafficSummary {
	/** Zero-filled last-30-days series, narinfo + NAR combined. */
	days: TrafficDay[];
	narinfo: TrafficTotals;
	nar: TrafficTotals;
	edge: EdgeTotals;
	/** Zero-filled last-30-days edge-cache series. */
	edgeDays: EdgeDay[];
	push: PushTotals;
	/** Zero-filled last-30-days push series. */
	pushDays: PushDay[];
	writes: StoreWriteTotals;
	/** Zero-filled last-30-days storage-write series. */
	writeDays: StoreWriteDay[];
	guards: GuardTotals;
}

interface SqlRow {
	day: string;
	kind: string;
	event: string;
	edge: string;
	n: number | string;
	bytes: number | string;
}

/** Last 30 days of read-path traffic, or null when unconfigured/unreachable. */
export async function loadTraffic(env: Env): Promise<TrafficSummary | null> {
	if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;

	// _sample_interval sums to the true event count under AE's sampling; the
	// same weighting recovers byte totals (double2, written by push points and
	// zero on read points).
	const sql = `
		SELECT toStartOfDay(timestamp) AS day, blob1 AS kind, blob2 AS event,
		       blob4 AS edge,
		       SUM(_sample_interval) AS n,
		       SUM(_sample_interval * double2) AS bytes
		FROM ${DATASET}
		WHERE timestamp > NOW() - INTERVAL '30' DAY
		GROUP BY day, kind, event, edge
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
	const zeroEdge = () => ({ hit: 0 });
	const zeroPush = (): PushTotals => ({ stored: 0, deduplicated: 0, bytes: 0 });
	const zeroWrite = () => ({ stored: 0, storedBytes: 0 });
	const narinfo = zero();
	const nar = zero();
	const edge: EdgeTotals = { hit: 0, origin: 0, other: 0 };
	const push = zeroPush();
	const writes: StoreWriteTotals = { stored: 0, deduplicated: 0, storedBytes: 0, dedupBytes: 0 };
	const guards: GuardTotals = { probe: 0, verdict: 0, ingest: 0 };
	const byDay = new Map<string, TrafficTotals>();
	const edgeByDay = new Map<string, { hit: number }>();
	const pushByDay = new Map<string, PushTotals>();
	const writeByDay = new Map<string, { stored: number; storedBytes: number }>();

	for (const row of rows) {
		const n = Number(row.n) || 0;
		const bytes = Number(row.bytes) || 0;
		const date = row.day.slice(0, 10);

		if (row.kind === 'push') {
			const event = row.event as 'stored' | 'deduplicated';
			if (event !== 'stored' && event !== 'deduplicated') continue;
			push[event] += n;
			push.bytes += bytes;
			const day = pushByDay.get(date) ?? zeroPush();
			day[event] += n;
			day.bytes += bytes;
			pushByDay.set(date, day);
			continue;
		}

		if (row.kind === 'guard') {
			if (row.event === 'probe' || row.event === 'verdict' || row.event === 'ingest') {
				guards[row.event] += n;
			}
			continue;
		}

		if (row.kind === 'chunk') {
			if (row.event === 'stored') {
				writes.stored += n;
				writes.storedBytes += bytes;
				const day = writeByDay.get(date) ?? zeroWrite();
				day.stored += n;
				day.storedBytes += bytes;
				writeByDay.set(date, day);
			} else if (row.event === 'deduplicated') {
				writes.deduplicated += n;
				writes.dedupBytes += bytes;
			}
			continue;
		}

		const event = row.event as keyof TrafficTotals;
		if (!(event in narinfo)) continue; // 'other' stays out of the summary
		const totals = row.kind === 'narinfo' ? narinfo : row.kind === 'nar' ? nar : null;
		if (!totals) continue;
		totals[event] += n;
		const day = byDay.get(date) ?? zero();
		day[event] += n;
		byDay.set(date, day);

		// Edge verdicts span narinfo + NAR; rows written before the edge blob
		// existed carry '' and land in `other`.
		if (row.edge === 'hit' || row.edge === 'origin') {
			edge[row.edge] += n;
			if (row.edge === 'hit') {
				const edgeDay = edgeByDay.get(date) ?? zeroEdge();
				edgeDay.hit += n;
				edgeByDay.set(date, edgeDay);
			}
		} else {
			edge.other += n;
		}
	}

	// Zero-fill so idle days chart as zero instead of being skipped.
	const days: TrafficDay[] = [];
	const edgeDays: EdgeDay[] = [];
	const pushDays: PushDay[] = [];
	const writeDays: StoreWriteDay[] = [];
	const DAY_MS = 86_400_000;
	const start = Date.now() - 29 * DAY_MS;
	for (let i = 0; i < 30; i++) {
		const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
		days.push({ date, ...(byDay.get(date) ?? zero()) });
		edgeDays.push({ date, ...(edgeByDay.get(date) ?? zeroEdge()) });
		pushDays.push({ date, ...(pushByDay.get(date) ?? zeroPush()) });
		writeDays.push({ date, ...(writeByDay.get(date) ?? zeroWrite()) });
	}
	return { days, narinfo, nar, edge, edgeDays, push, pushDays, writes, writeDays, guards };
}
