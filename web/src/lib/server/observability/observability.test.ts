import { describe, expect, it } from 'vitest';
import { buildQueries, parseWindow, WINDOWS } from './query';
import { summarize, STAGES, type RawResults } from './parse';
import { fixtureResults } from './fixtures';

const NOW = Date.parse('2026-09-29T12:34:56Z');
const empty = (): RawResults => ({
	series: [],
	overall: [],
	routes: [],
	edge: [],
	colos: [],
	regions: [],
	events: []
});
const latency = (over: Record<string, unknown> = {}) => ({
	n: 0,
	e5: 0,
	e4: 0,
	edge_hit: 0,
	edge_origin: 0,
	p50: 0,
	p95: 0,
	p99: 0,
	d1: 0,
	d1_primary: 0,
	rows_read: 0,
	rows_written: 0,
	r2: 0,
	d1_sql_ms: 0,
	...over
});

describe('buildQueries', () => {
	it('windows, weights and scopes every query', () => {
		const q = buildQueries(WINDOWS['7d']);
		for (const sql of Object.values(q)) {
			expect(sql).toContain("INTERVAL '7' DAY");
			expect(sql).toContain('_sample_interval * double1');
			expect(sql).toContain('FORMAT JSON');
		}
		expect(q.series).toContain('toStartOfHour(timestamp)');
		// Quantile weights must be integral.
		expect(q.overall).toContain(
			'quantileExactWeighted(0.99)(double2, toUInt32(_sample_interval * double1))'
		);
		// Client-facing views count the gateway layer only.
		expect(q.edge).toContain("blob2 = 'gateway'");
		expect(q.colos).toContain("blob2 = 'gateway'");
		// p50 / p95 / p99 everywhere latency is reported.
		for (const k of ['series', 'overall', 'routes', 'edge', 'colos'] as const) {
			expect(q[k]).toContain('quantileExactWeighted(0.99)');
		}
	});

	it('defaults unknown windows to 24h', () => {
		expect(parseWindow(null)).toBe('24h');
		expect(parseWindow('1y')).toBe('24h');
		expect(parseWindow('1h')).toBe('1h');
	});
});

describe('summarize', () => {
	const w = WINDOWS['1h'];

	it('zero-fills buckets and counts requests at the gateway but work across layers', () => {
		const raw = empty();
		raw.series.push(
			{
				t: '2026-09-29 12:30:00',
				layer: 'gateway',
				...latency({ n: 120, e5: 3, p95: 80, d1: 2, r2: 1 })
			},
			{
				t: '2026-09-29 12:30:00',
				layer: 'store',
				...latency({ n: 40, p95: 60, d1: 30, d1_primary: 3, r2: 5 })
			}
		);
		const s = summarize(w, raw, NOW);
		expect(s.series).toHaveLength(60);
		expect(s.series.at(-1)!.t).toBe('2026-09-29T12:34:00.000Z');
		const p = s.series.find((x) => x.t === '2026-09-29T12:30:00.000Z')!;
		expect(p.requests).toBe(120);
		expect(p.rps).toBe(2);
		expect(p.errors5xx).toBe(3);
		expect(p.d1).toBe(32);
		expect(p.d1Primary).toBe(3);
		expect(p.r2).toBe(6);
		expect(p.gateway.p95).toBe(80);
		expect(p.store.p95).toBe(60);
		expect(s.series.filter((x) => x.requests === 0)).toHaveLength(59);
	});

	it('derives per-route rates and attributes unexplained time to "other"', () => {
		const raw = empty();
		raw.routes.push({
			layer: 'gateway',
			route: 'GET /:cache/:hash.narinfo',
			...latency({ n: 100, e4: 2, e5: 1, edge_hit: 60, edge_origin: 20, d1: 50, d1_primary: 5 }),
			total_ms: 3000,
			auth_ms: 200,
			candidates_ms: 0,
			store_ms: 1000,
			upstream_ms: 0,
			admission_ms: 0,
			d1_ms: 500,
			r2_ms: 0,
			bytes: 80_000,
			sized: 100
		});
		const [r] = summarize(w, raw, NOW).routes;
		expect(r.errorRate).toBeCloseTo(0.03);
		expect(r.edgeHitRate).toBeCloseTo(0.75);
		expect(r.primaryShare).toBeCloseTo(0.1);
		expect(r.meanMs).toBe(30);
		expect(r.stages.other).toBeCloseTo(13);
		expect(STAGES.reduce((a, k) => a + r.stages[k], 0)).toBeCloseTo(r.meanMs);
		expect(r.avgBytes).toBe(800);
	});

	it('collapses edge spellings and counts only rejected rate-limit outcomes', () => {
		const raw = empty();
		raw.edge.push(
			{ edge: 'HIT', n: 90, p50: 5, p95: 20, p99: 40 },
			{ edge: 'STALE', n: 10, p50: 6, p95: 25, p99: 60 },
			{ edge: 'MISS', n: 30, p50: 50, p95: 200, p99: 700 }
		);
		raw.events.push(
			{ t: '2026-09-29 12:30:00', kind: 'limit', event: 'rejected', label: 'api', n: 4, bytes: 0 },
			{ t: '2026-09-29 12:30:00', kind: 'limit', event: 'error', label: 'api', n: 9, bytes: 0 },
			{ t: '2026-09-29 12:30:00', kind: 'narinfo', event: 'hit', label: 'main', n: 7, bytes: 0 }
		);
		const s = summarize(w, raw, NOW);
		expect(s.edge).toEqual([
			{ verdict: 'hit', requests: 100, p50: 5, p95: 20, p99: 40 },
			{ verdict: 'origin', requests: 30, p50: 50, p95: 200, p99: 700 }
		]);
		expect(s.rateLimited.api).toBe(4);
		expect(s.reads.narinfo.hit).toBe(7);
	});
});

describe('fixtures', () => {
	it('are deterministic and parse into a full window', () => {
		for (const key of ['1h', '24h', '7d', '30d'] as const) {
			const a = summarize(WINDOWS[key], fixtureResults(WINDOWS[key], NOW), NOW);
			const b = summarize(WINDOWS[key], fixtureResults(WINDOWS[key], NOW), NOW);
			expect(a).toEqual(b);
			expect(a.series).toHaveLength(WINDOWS[key].buckets);
			expect(a.series.every((p) => p.requests > 0)).toBe(true);
			expect(a.totals.d1Primary).toBeLessThan(a.totals.d1);
		}
	});
});
