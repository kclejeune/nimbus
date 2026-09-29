// Dev-only sample metrics, shaped exactly like Analytics Engine rows so the
// parser and page are exercised end to end without credentials. Enabled by
// OBSERVABILITY_FIXTURES=1 in .dev.vars (load.ts); never used in production.
// Deterministic per window and bucket so screenshots are stable.
import type { WindowSpec } from './query';
import type { RawResults } from './parse';

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface RouteProfile {
	layer: 'gateway' | 'store';
	route: string;
	share: number;
	p50: number;
	p95: number;
	p99: number;
	edgeHit: number | null;
	err: number;
	d1: number;
	primary: number;
	rowsRead: number;
	rowsWritten: number;
	r2: number;
	bytes: number | null;
	stages: Partial<
		Record<'auth' | 'candidates' | 'store' | 'upstream' | 'admission' | 'd1' | 'r2', number>
	>;
}

const ROUTES: RouteProfile[] = [
	{
		layer: 'gateway',
		route: 'GET /:cache/:hash.narinfo',
		share: 0.46,
		p50: 14,
		p95: 62,
		p99: 170,
		edgeHit: 0.9,
		err: 0.002,
		d1: 0.1,
		primary: 0.02,
		rowsRead: 1.2,
		rowsWritten: 0,
		r2: 0,
		bytes: 780,
		stages: { auth: 1.8, store: 12, d1: 2.1 }
	},
	{
		layer: 'gateway',
		route: 'GET /:hash.narinfo',
		share: 0.14,
		p50: 19,
		p95: 88,
		p99: 240,
		edgeHit: 0.82,
		err: 0.003,
		d1: 0.3,
		primary: 0.03,
		rowsRead: 2.6,
		rowsWritten: 0,
		r2: 0,
		bytes: 820,
		stages: { auth: 1.5, candidates: 6, store: 14, d1: 3.2 }
	},
	{
		layer: 'gateway',
		route: 'GET /:cache/nar/:file',
		share: 0.17,
		p50: 38,
		p95: 240,
		p99: 820,
		edgeHit: 0.71,
		err: 0.004,
		d1: 0.2,
		primary: 0.02,
		rowsRead: 1.5,
		rowsWritten: 0.02,
		r2: 0.6,
		bytes: 24_000_000,
		stages: { auth: 1.9, store: 34, r2: 18 }
	},
	{
		layer: 'gateway',
		route: 'GET /:cache/nix-cache-info',
		share: 0.06,
		p50: 6,
		p95: 21,
		p99: 48,
		edgeHit: 0.97,
		err: 0,
		d1: 0,
		primary: 0,
		rowsRead: 0,
		rowsWritten: 0,
		r2: 0,
		bytes: 64,
		stages: { auth: 0.4, store: 4 }
	},
	{
		layer: 'gateway',
		route: 'POST /_api/v1/get-missing-paths',
		share: 0.05,
		p50: 84,
		p95: 330,
		p99: 910,
		edgeHit: null,
		err: 0.006,
		d1: 6.4,
		primary: 0.08,
		rowsRead: 410,
		rowsWritten: 0,
		r2: 0,
		bytes: 2_400,
		stages: { auth: 3.1, admission: 4, d1: 58, upstream: 12 }
	},
	{
		layer: 'gateway',
		route: 'PUT /_api/v1/upload-path',
		share: 0.018,
		p50: 620,
		p95: 2900,
		p99: 7400,
		edgeHit: null,
		err: 0.012,
		d1: 14,
		primary: 0.96,
		rowsRead: 96,
		rowsWritten: 22,
		r2: 3.4,
		bytes: 180,
		stages: { auth: 3.6, admission: 38, d1: 140, r2: 360 }
	},
	{
		layer: 'gateway',
		route: 'POST /_api/v1/upload-path/chunks',
		share: 0.009,
		p50: 410,
		p95: 1800,
		p99: 4100,
		edgeHit: null,
		err: 0.02,
		d1: 9,
		primary: 0.97,
		rowsRead: 60,
		rowsWritten: 11,
		r2: 5.1,
		bytes: 120,
		stages: { auth: 3.2, admission: 22, d1: 90, r2: 260 }
	},
	{
		layer: 'gateway',
		route: 'GET /_api/v1/cache-config/:id',
		share: 0.01,
		p50: 22,
		p95: 80,
		p99: 190,
		edgeHit: null,
		err: 0.001,
		d1: 2,
		primary: 0.05,
		rowsRead: 6,
		rowsWritten: 0,
		r2: 0,
		bytes: 900,
		stages: { auth: 3.4, d1: 14 }
	},
	{
		layer: 'store',
		route: 'GET /_proxy/:cache/:hash.narinfo',
		share: 0.01,
		p50: 120,
		p95: 420,
		p99: 1100,
		edgeHit: 0.4,
		err: 0.01,
		d1: 1.1,
		primary: 0.4,
		rowsRead: 4,
		rowsWritten: 0.6,
		r2: 0,
		bytes: 700,
		stages: { auth: 1.5, upstream: 96, d1: 8 }
	},
	{
		layer: 'store',
		route: 'GET /_meta/:kind/:hash',
		share: 0.09,
		p50: 24,
		p95: 96,
		p99: 260,
		edgeHit: null,
		err: 0.002,
		d1: 2.4,
		primary: 0.03,
		rowsRead: 12,
		rowsWritten: 0,
		r2: 0,
		bytes: 780,
		stages: { d1: 18 }
	},
	{
		layer: 'store',
		route: 'GET /_nar/:hash',
		share: 0.05,
		p50: 55,
		p95: 380,
		p99: 1300,
		edgeHit: null,
		err: 0.003,
		d1: 1.2,
		primary: 0.02,
		rowsRead: 5,
		rowsWritten: 0,
		r2: 1.7,
		bytes: 24_000_000,
		stages: { d1: 9, r2: 41 }
	},
	{
		layer: 'store',
		route: 'POST /_touch/:cache/:hash',
		share: 0.02,
		p50: 12,
		p95: 40,
		p99: 95,
		edgeHit: null,
		err: 0,
		d1: 0.4,
		primary: 0.4,
		rowsRead: 1,
		rowsWritten: 0.4,
		r2: 0,
		bytes: null,
		stages: { d1: 8 }
	}
];

const COLOS: [string, number, number][] = [
	['IAD', 0.21, 1],
	['SJC', 0.14, 1.1],
	['FRA', 0.12, 1.25],
	['ORD', 0.1, 1.05],
	['AMS', 0.09, 1.3],
	['LHR', 0.08, 1.2],
	['SEA', 0.07, 1.1],
	['NRT', 0.06, 1.9],
	['SIN', 0.05, 2.1],
	['SYD', 0.04, 2.4],
	['GRU', 0.04, 2.2]
];

/** Diurnal request rate (req/s), peaking mid-afternoon UTC. */
function rateAt(t: number): number {
	const hour = (t / 3_600_000) % 24;
	return 16 * (1 + 0.55 * Math.sin(((hour - 9) / 24) * 2 * Math.PI));
}

export function fixtureResults(w: WindowSpec, now = Date.now()): RawResults {
	const step = w.stepSeconds * 1000;
	const end = Math.floor(now / step) * step;
	const buckets = Array.from({ length: w.buckets }, (_, i) => end - (w.buckets - 1 - i) * step);
	// One short incident two-thirds of the way through the window.
	const incident = buckets[Math.floor(w.buckets * 0.66)];
	const aeTime = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

	const series: RawResults['series'] = [];
	const events: RawResults['events'] = [];
	const gatewayShare = ROUTES.filter((r) => r.layer === 'gateway').reduce((s, r) => s + r.share, 0);
	const storeShare = ROUTES.filter((r) => r.layer === 'store').reduce((s, r) => s + r.share, 0);

	for (const t of buckets) {
		const r = rng(t / 1000 + w.stepSeconds);
		const bad = t === incident;
		const n = rateAt(t) * w.stepSeconds * (0.85 + 0.3 * r());
		const gw = n;
		const st = n * (storeShare / gatewayShare);
		const jitter = () => 0.85 + 0.3 * r();
		const common = (count: number, scale: number) => ({
			d1: count * (bad ? 2.1 : 1.3) * jitter() * scale,
			d1_primary: count * (bad ? 0.5 : 0.11) * jitter() * scale,
			rows_read: count * 38 * jitter() * scale,
			rows_written: count * 0.6 * jitter() * scale,
			r2: count * 0.14 * jitter() * scale,
			d1_sql_ms: count * 9 * jitter() * scale
		});
		series.push({
			t: aeTime(t),
			layer: 'gateway',
			n: gw,
			e5: gw * (bad ? 0.045 : 0.0015 * jitter()),
			e4: gw * 0.018 * jitter(),
			edge_hit: gw * 0.66 * (bad ? 0.8 : jitter() * 0.95),
			edge_origin: gw * 0.14 * jitter(),
			p50: 17 * jitter() * (bad ? 1.6 : 1),
			p95: 190 * jitter() * (bad ? 2.4 : 1),
			p99: 720 * jitter() * (bad ? 3.8 : 1),
			...common(gw, 0.08)
		});
		series.push({
			t: aeTime(t),
			layer: 'store',
			n: st,
			e5: st * (bad ? 0.06 : 0.001),
			e4: 0,
			edge_hit: 0,
			edge_origin: 0,
			p50: 28 * jitter() * (bad ? 1.8 : 1),
			p95: 150 * jitter() * (bad ? 2.6 : 1),
			p99: 480 * jitter() * (bad ? 3.2 : 1),
			...common(st, 1)
		});
		const reads = gw * 0.8;
		const readRows: [string, string, number][] = [
			['narinfo', 'hit', reads * 0.62 * 0.78],
			['narinfo', 'miss', reads * 0.62 * 0.14],
			['narinfo', 'upstream', reads * 0.62 * 0.08],
			['nar', 'hit', reads * 0.2 * 0.9],
			['nar', 'upstream', reads * 0.2 * 0.08],
			['nar', 'miss', reads * 0.2 * 0.02]
		];
		for (const [kind, event, count] of readRows) {
			events.push({ t: aeTime(t), kind, event, label: 'main', n: count, bytes: 0 });
		}
		const pushes = gw * 0.018;
		events.push({
			t: aeTime(t),
			kind: 'push',
			event: 'stored',
			label: 'main',
			n: pushes * 0.38,
			bytes: pushes * 0.38 * 31e6
		});
		events.push({
			t: aeTime(t),
			kind: 'push',
			event: 'deduplicated',
			label: 'main',
			n: pushes * 0.62,
			bytes: pushes * 0.62 * 28e6
		});
		events.push({
			t: aeTime(t),
			kind: 'chunk',
			event: 'stored',
			label: '_storage',
			n: pushes * 1.9,
			bytes: pushes * 1.9 * 4.1e6
		});
		events.push({
			t: aeTime(t),
			kind: 'chunk',
			event: 'deduplicated',
			label: '_storage',
			n: pushes * 2.7,
			bytes: pushes * 2.7 * 3.8e6
		});
		if (r() < 0.12)
			events.push({
				t: aeTime(t),
				kind: 'guard',
				event: 'probe',
				label: '_guard',
				n: Math.ceil(r() * 40),
				bytes: 0
			});
		if (bad)
			events.push({
				t: aeTime(t),
				kind: 'limit',
				event: 'rejected',
				label: 'api',
				n: 180,
				bytes: 0
			});
	}

	const total = series.filter((s) => s.layer === 'gateway').reduce((s, p) => s + Number(p.n), 0);
	const totalStore = series.filter((s) => s.layer === 'store').reduce((s, p) => s + Number(p.n), 0);
	const sumOf = (
		layer: string,
		k:
			| 'd1'
			| 'd1_primary'
			| 'rows_read'
			| 'rows_written'
			| 'r2'
			| 'd1_sql_ms'
			| 'e4'
			| 'e5'
			| 'edge_hit'
			| 'edge_origin'
	) => series.filter((s) => s.layer === layer).reduce((a, p) => a + Number(p[k]), 0);
	const overall: RawResults['overall'] = (['gateway', 'store'] as const).map((layer) => ({
		layer,
		n: layer === 'gateway' ? total : totalStore,
		e4: sumOf(layer, 'e4'),
		e5: sumOf(layer, 'e5'),
		edge_hit: sumOf(layer, 'edge_hit'),
		edge_origin: sumOf(layer, 'edge_origin'),
		p50: layer === 'gateway' ? 17.4 : 27.9,
		p95: layer === 'gateway' ? 196 : 158,
		p99: layer === 'gateway' ? 790 : 520,
		d1: sumOf(layer, 'd1'),
		d1_primary: sumOf(layer, 'd1_primary'),
		rows_read: sumOf(layer, 'rows_read'),
		rows_written: sumOf(layer, 'rows_written'),
		r2: sumOf(layer, 'r2'),
		d1_sql_ms: sumOf(layer, 'd1_sql_ms')
	}));

	const routes: RawResults['routes'] = ROUTES.map((p) => {
		const n = (p.layer === 'gateway' ? total / gatewayShare : totalStore / storeShare) * p.share;
		const s = p.stages;
		const staged = Object.values(s).reduce((a, b) => a + (b ?? 0), 0);
		const mean = Math.max(staged * 1.08, p.p50 * 1.4);
		return {
			layer: p.layer,
			route: p.route,
			n,
			e5: n * p.err * 0.4,
			e4: n * p.err * 0.6,
			edge_hit: p.edgeHit === null ? 0 : n * p.edgeHit,
			edge_origin: p.edgeHit === null ? 0 : n * (1 - p.edgeHit),
			p50: p.p50,
			p95: p.p95,
			p99: p.p99,
			d1: n * p.d1,
			d1_primary: n * p.d1 * p.primary,
			rows_read: n * p.rowsRead,
			rows_written: n * p.rowsWritten,
			r2: n * p.r2,
			d1_sql_ms: n * p.d1 * 3,
			total_ms: n * mean,
			auth_ms: n * (s.auth ?? 0),
			candidates_ms: n * (s.candidates ?? 0),
			store_ms: n * (s.store ?? 0),
			upstream_ms: n * (s.upstream ?? 0),
			admission_ms: n * (s.admission ?? 0),
			d1_ms: n * (s.d1 ?? 0),
			r2_ms: n * (s.r2 ?? 0),
			bytes: p.bytes === null ? 0 : n * p.bytes,
			sized: p.bytes === null ? 0 : n
		};
	});

	const edge: RawResults['edge'] = [
		{ edge: 'HIT', n: total * 0.64, p50: 7.8, p95: 31, p99: 74 },
		{ edge: 'STALE', n: total * 0.02, p50: 8.4, p95: 36, p99: 81 },
		{ edge: 'MISS', n: total * 0.12, p50: 61, p95: 290, p99: 910 },
		{ edge: 'EXPIRED', n: total * 0.02, p50: 70, p95: 330, p99: 1040 },
		{ edge: 'NONE', n: total * 0.2, p50: 104, p95: 1100, p99: 3900 }
	];

	const colos: RawResults['colos'] = COLOS.map(([colo, share, slow]) => ({
		colo,
		n: total * share,
		edge_hit: total * share * 0.8 * (1 - (slow - 1) * 0.08),
		edge_origin: total * share * 0.2,
		p50: 15 * slow,
		p95: 170 * slow,
		p99: 640 * slow
	}));

	const d1Total = overall.reduce((a, o) => a + Number(o.d1), 0);
	const regions: RawResults['regions'] = [
		{
			region: 'ENAM',
			d1: d1Total * 0.46,
			d1_primary: d1Total * 0.46 * 0.31,
			d1_sql_ms: d1Total * 0.46 * 2.4
		},
		{ region: 'WNAM', d1: d1Total * 0.22, d1_primary: 0, d1_sql_ms: d1Total * 0.22 * 2.9 },
		{ region: 'WEUR', d1: d1Total * 0.2, d1_primary: 0, d1_sql_ms: d1Total * 0.2 * 3.1 },
		{ region: 'APAC', d1: d1Total * 0.09, d1_primary: 0, d1_sql_ms: d1Total * 0.09 * 3.6 },
		{ region: 'OC', d1: d1Total * 0.03, d1_primary: 0, d1_sql_ms: d1Total * 0.03 * 4.2 }
	];

	return { series, overall, routes, edge, colos, regions, events };
}
