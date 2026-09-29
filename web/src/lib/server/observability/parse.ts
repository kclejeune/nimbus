// Row → summary for the performance views. Pure, so fixture rows and real
// Analytics Engine rows go through the same code (and the same tests).
import type { WindowSpec } from './query';

type Num = number | string | null | undefined;
const num = (v: Num): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

/** AE returns `YYYY-MM-DD hh:mm:ss` in UTC. */
function epoch(t: string): number {
	return Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
}

interface LatencyRow {
	n: Num;
	e5: Num;
	e4: Num;
	edge_hit: Num;
	edge_origin: Num;
	p50: Num;
	p95: Num;
	p99: Num;
	d1: Num;
	d1_primary: Num;
	rows_read: Num;
	rows_written: Num;
	r2: Num;
	d1_sql_ms: Num;
}
export interface SeriesRow extends LatencyRow {
	t: string;
	layer: string;
}
export interface OverallRow extends LatencyRow {
	layer: string;
}
export interface RouteRow extends LatencyRow {
	layer: string;
	route: string;
	total_ms: Num;
	auth_ms: Num;
	candidates_ms: Num;
	store_ms: Num;
	upstream_ms: Num;
	admission_ms: Num;
	d1_ms: Num;
	r2_ms: Num;
	bytes: Num;
	sized: Num;
}
export interface EdgeRow {
	edge: string;
	n: Num;
	p50: Num;
	p95: Num;
	p99: Num;
}
export interface ColoRow {
	colo: string;
	n: Num;
	edge_hit: Num;
	edge_origin: Num;
	p50: Num;
	p95: Num;
	p99: Num;
}
export interface RegionRow {
	region: string;
	d1: Num;
	d1_primary: Num;
	d1_sql_ms: Num;
}
export interface EventRow {
	t: string;
	kind: string;
	event: string;
	label: string;
	n: Num;
	bytes: Num;
}

export interface RawResults {
	series: SeriesRow[];
	overall: OverallRow[];
	routes: RouteRow[];
	edge: EdgeRow[];
	colos: ColoRow[];
	regions: RegionRow[];
	events: EventRow[];
}

export interface Percentiles {
	p50: number;
	p95: number;
	p99: number;
}

export interface SeriesPoint {
	/** Bucket start, ISO. */
	t: string;
	/** Client requests (gateway layer). */
	requests: number;
	/** Requests per second over the bucket. */
	rps: number;
	errors4xx: number;
	errors5xx: number;
	edgeHit: number;
	edgeOrigin: number;
	/** Gateway header latency, ms. Zero in an empty bucket. */
	gateway: Percentiles;
	/** Store (CachedStore) header latency, ms. */
	store: Percentiles;
	/** D1 statements across both layers, and how many hit the primary. */
	d1: number;
	d1Primary: number;
	rowsRead: number;
	rowsWritten: number;
	r2: number;
	/** Chunk-level R2 writes and bytes (includes pull-through). */
	chunkWrites: number;
	pushes: number;
}

export interface RouteStats extends Percentiles {
	layer: 'gateway' | 'store';
	route: string;
	requests: number;
	rps: number;
	errorRate: number;
	/** Of edge-cacheable responses, the share the edge answered; null when none were cacheable. */
	edgeHitRate: number | null;
	/** Per request averages. */
	d1PerRequest: number;
	primaryShare: number | null;
	rowsReadPerRequest: number;
	r2PerRequest: number;
	avgBytes: number | null;
	/** Mean ms per request spent in each stage; `other` is the unattributed rest. */
	stages: Record<Stage, number>;
	meanMs: number;
}

export const STAGES = ['auth', 'store', 'd1', 'r2', 'upstream', 'admission', 'other'] as const;
export type Stage = (typeof STAGES)[number];

export interface Totals extends Percentiles {
	requests: number;
	rps: number;
	errors4xx: number;
	errors5xx: number;
	edgeHit: number;
	edgeOrigin: number;
	d1: number;
	d1Primary: number;
	rowsRead: number;
	rowsWritten: number;
	r2: number;
	d1SqlMs: number;
	storeLatency: Percentiles;
}

export interface Observability {
	window: WindowSpec;
	totals: Totals;
	series: SeriesPoint[];
	routes: RouteStats[];
	/** Gateway latency by edge verdict, collapsed to hit / origin / not cached. */
	edge: ({ verdict: 'hit' | 'origin' | 'uncached'; requests: number } & Percentiles)[];
	colos: ({ colo: string; requests: number; edgeHitRate: number | null } & Percentiles)[];
	regions: { region: string; statements: number; primaryShare: number; meanSqlMs: number }[];
	reads: {
		narinfo: { hit: number; miss: number; upstream: number };
		nar: { hit: number; miss: number; upstream: number };
	};
	pushes: { stored: number; deduplicated: number; bytes: number };
	chunkWrites: { stored: number; deduplicated: number; storedBytes: number; dedupBytes: number };
	guards: { probe: number; verdict: number; ingest: number };
	rateLimited: { api: number; mutation: number; gc: number };
}

const pct = (r: LatencyRow): Percentiles => ({ p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) });
const ZERO_PCT: Percentiles = { p50: 0, p95: 0, p99: 0 };

function edgeVerdict(status: string): 'hit' | 'origin' | 'uncached' {
	const s = status.toUpperCase();
	if (s === 'HIT' || s === 'STALE' || s === 'UPDATING') return 'hit';
	if (s === 'MISS' || s === 'EXPIRED' || s === 'REVALIDATED') return 'origin';
	return 'uncached';
}

export function summarize(w: WindowSpec, raw: RawResults, now = Date.now()): Observability {
	const windowSeconds = w.stepSeconds * w.buckets;

	// --- series: zero-filled buckets, gateway counts + both layers' work.
	const step = w.stepSeconds * 1000;
	const end = Math.floor(now / step) * step;
	const start = end - (w.buckets - 1) * step;
	const empty = (t: number): SeriesPoint => ({
		t: new Date(t).toISOString(),
		requests: 0,
		rps: 0,
		errors4xx: 0,
		errors5xx: 0,
		edgeHit: 0,
		edgeOrigin: 0,
		gateway: { ...ZERO_PCT },
		store: { ...ZERO_PCT },
		d1: 0,
		d1Primary: 0,
		rowsRead: 0,
		rowsWritten: 0,
		r2: 0,
		chunkWrites: 0,
		pushes: 0
	});
	const byBucket = new Map<number, SeriesPoint>();
	for (let t = start; t <= end; t += step) byBucket.set(t, empty(t));
	// Daily buckets align to UTC midnight, which `floor(now / step)` already
	// matches; anything outside the window (clock skew) is dropped.
	const at = (t: string) => byBucket.get(Math.floor(epoch(t) / step) * step);

	for (const r of raw.series) {
		const p = at(r.t);
		if (!p) continue;
		p.d1 += num(r.d1);
		p.d1Primary += num(r.d1_primary);
		p.rowsRead += num(r.rows_read);
		p.rowsWritten += num(r.rows_written);
		p.r2 += num(r.r2);
		if (r.layer === 'gateway') {
			p.requests = num(r.n);
			p.rps = p.requests / w.stepSeconds;
			p.errors4xx = num(r.e4);
			p.errors5xx = num(r.e5);
			p.edgeHit = num(r.edge_hit);
			p.edgeOrigin = num(r.edge_origin);
			p.gateway = pct(r);
		} else if (r.layer === 'store') {
			p.store = pct(r);
		}
	}
	for (const e of raw.events) {
		const p = at(e.t);
		if (!p) continue;
		if (e.kind === 'chunk' && e.event === 'stored') p.chunkWrites += num(e.n);
		if (e.kind === 'push') p.pushes += num(e.n);
	}

	// --- totals
	const gw = raw.overall.find((r) => r.layer === 'gateway');
	const st = raw.overall.find((r) => r.layer === 'store');
	const sum = (k: keyof LatencyRow) => raw.overall.reduce((s, r) => s + num(r[k]), 0);
	const requests = num(gw?.n);
	const totals: Totals = {
		requests,
		rps: requests / windowSeconds,
		errors4xx: num(gw?.e4),
		errors5xx: num(gw?.e5),
		edgeHit: num(gw?.edge_hit),
		edgeOrigin: num(gw?.edge_origin),
		...(gw ? pct(gw) : ZERO_PCT),
		storeLatency: st ? pct(st) : { ...ZERO_PCT },
		d1: sum('d1'),
		d1Primary: sum('d1_primary'),
		rowsRead: sum('rows_read'),
		rowsWritten: sum('rows_written'),
		r2: sum('r2'),
		d1SqlMs: sum('d1_sql_ms')
	};

	// --- routes
	const routes: RouteStats[] = raw.routes
		.filter((r) => r.layer === 'gateway' || r.layer === 'store')
		.map((r) => {
			const n = num(r.n);
			const per = (v: Num) => (n > 0 ? num(v) / n : 0);
			const cacheable = num(r.edge_hit) + num(r.edge_origin);
			const meanMs = per(r.total_ms);
			const stages = {
				auth: per(r.auth_ms),
				// Candidate lookup is the store-side part of resolving a read.
				store: per(r.store_ms) + per(r.candidates_ms),
				d1: per(r.d1_ms),
				r2: per(r.r2_ms),
				upstream: per(r.upstream_ms),
				admission: per(r.admission_ms),
				other: 0
			};
			const attributed = STAGES.slice(0, -1).reduce((s, k) => s + stages[k], 0);
			stages.other = Math.max(0, meanMs - attributed);
			const d1 = num(r.d1);
			return {
				layer: r.layer as 'gateway' | 'store',
				route: r.route,
				requests: n,
				rps: n / windowSeconds,
				errorRate: n > 0 ? (num(r.e4) + num(r.e5)) / n : 0,
				edgeHitRate: cacheable > 0 ? num(r.edge_hit) / cacheable : null,
				d1PerRequest: per(r.d1),
				primaryShare: d1 > 0 ? num(r.d1_primary) / d1 : null,
				rowsReadPerRequest: per(r.rows_read),
				r2PerRequest: per(r.r2),
				avgBytes: num(r.sized) > 0 ? num(r.bytes) / num(r.sized) : null,
				stages,
				meanMs,
				...pct(r)
			};
		});

	// --- edge verdicts (collapse the CF-Cache-Status spellings)
	const edgeMap = new Map<'hit' | 'origin' | 'uncached', { requests: number } & Percentiles>();
	for (const r of raw.edge) {
		const v = edgeVerdict(r.edge ?? '');
		const cur = edgeMap.get(v);
		const n = num(r.n);
		const q = { p50: num(r.p50), p95: num(r.p95), p99: num(r.p99) };
		// Quantiles don't merge across spellings; keep the busiest one's as
		// representative (HIT dwarfs STALE, MISS dwarfs EXPIRED in practice).
		if (!cur) edgeMap.set(v, { requests: n, ...q });
		else if (n > cur.requests) edgeMap.set(v, { requests: cur.requests + n, ...q });
		else cur.requests += n;
	}
	const edge = (['hit', 'origin', 'uncached'] as const)
		.filter((v) => edgeMap.has(v))
		.map((v) => ({ verdict: v, ...edgeMap.get(v)! }));

	const colos = raw.colos.map((r) => {
		const cacheable = num(r.edge_hit) + num(r.edge_origin);
		return {
			colo: r.colo || 'unknown',
			requests: num(r.n),
			edgeHitRate: cacheable > 0 ? num(r.edge_hit) / cacheable : null,
			p50: num(r.p50),
			p95: num(r.p95),
			p99: num(r.p99)
		};
	});

	const regions = raw.regions.map((r) => ({
		region: r.region,
		statements: num(r.d1),
		primaryShare: num(r.d1) > 0 ? num(r.d1_primary) / num(r.d1) : 0,
		meanSqlMs: num(r.d1) > 0 ? num(r.d1_sql_ms) / num(r.d1) : 0
	}));

	// --- non-latency events
	const reads = {
		narinfo: { hit: 0, miss: 0, upstream: 0 },
		nar: { hit: 0, miss: 0, upstream: 0 }
	};
	const pushes = { stored: 0, deduplicated: 0, bytes: 0 };
	const chunkWrites = { stored: 0, deduplicated: 0, storedBytes: 0, dedupBytes: 0 };
	const guards = { probe: 0, verdict: 0, ingest: 0 };
	const rateLimited = { api: 0, mutation: 0, gc: 0 };
	for (const e of raw.events) {
		const n = num(e.n);
		const bytes = num(e.bytes);
		if ((e.kind === 'narinfo' || e.kind === 'nar') && e.event in reads[e.kind]) {
			reads[e.kind][e.event as 'hit' | 'miss' | 'upstream'] += n;
		} else if (e.kind === 'push' && (e.event === 'stored' || e.event === 'deduplicated')) {
			pushes[e.event] += n;
			pushes.bytes += bytes;
		} else if (e.kind === 'chunk' && e.event === 'stored') {
			chunkWrites.stored += n;
			chunkWrites.storedBytes += bytes;
		} else if (e.kind === 'chunk' && e.event === 'deduplicated') {
			chunkWrites.deduplicated += n;
			chunkWrites.dedupBytes += bytes;
		} else if (e.kind === 'guard' && e.event in guards) {
			guards[e.event as keyof typeof guards] += n;
		} else if (e.kind === 'limit' && e.event === 'rejected' && e.label in rateLimited) {
			rateLimited[e.label as keyof typeof rateLimited] += n;
		}
	}

	return {
		window: w,
		totals,
		series: [...byBucket.values()],
		routes,
		edge,
		colos,
		regions,
		reads,
		pushes,
		chunkWrites,
		guards,
		rateLimited
	};
}
