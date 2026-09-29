// Runs the performance queries against the Analytics Engine SQL API. Needs an
// account-scoped token, so it's config-gated: without CF_ACCOUNT_ID and
// CF_ANALYTICS_TOKEN the page shows how to connect it (or, in local dev with
// OBSERVABILITY_FIXTURES=1, generated sample data).
import { dev } from '$app/environment';
import { buildQueries, WINDOWS, type WindowKey } from './query';
import { summarize, type Observability, type RawResults } from './parse';
import { fixtureResults } from './fixtures';

type Env = App.Platform['env'];

const QUERY_TIMEOUT_MS = 8_000;

export type ObservabilityResult =
	| { status: 'ok'; data: Observability; sample: boolean }
	| { status: 'unconfigured' }
	| { status: 'error'; message: string };

export async function loadObservability(
	env: Env,
	windowKey: WindowKey
): Promise<ObservabilityResult> {
	const w = WINDOWS[windowKey];
	if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
		if (dev && env.OBSERVABILITY_FIXTURES === '1') {
			return { status: 'ok', data: summarize(w, fixtureResults(w)), sample: true };
		}
		return { status: 'unconfigured' };
	}

	const queries = buildQueries(w);
	const run = async <T>(sql: string): Promise<T[]> => {
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
			throw new Error(`Analytics Engine returned ${response.status}: ${await response.text()}`);
		}
		return ((await response.json()) as { data: T[] }).data;
	};

	try {
		const [series, overall, routes, edge, colos, regions, events] = await Promise.all([
			run<RawResults['series'][number]>(queries.series),
			run<RawResults['overall'][number]>(queries.overall),
			run<RawResults['routes'][number]>(queries.routes),
			run<RawResults['edge'][number]>(queries.edge),
			run<RawResults['colos'][number]>(queries.colos),
			run<RawResults['regions'][number]>(queries.regions),
			run<RawResults['events'][number]>(queries.events)
		]);
		return {
			status: 'ok',
			data: summarize(w, { series, overall, routes, edge, colos, regions, events }),
			sample: false
		};
	} catch (e) {
		console.warn(`observability query failed: ${e}`);
		return { status: 'error', message: e instanceof Error ? e.message : String(e) };
	}
}
