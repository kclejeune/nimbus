<script lang="ts">
	import Segmented from './segmented.svelte';
	import StatTile from './stat-tile.svelte';
	import SectionHead from './section-head.svelte';
	import { formatBytes, formatCompact, formatMs, formatPct, formatRate } from '$lib/format';
	import type { ObservabilityResult } from '$lib/server/observability/load';
	import TimeSeries from '$lib/components/charts/time-series.svelte';
	import BarList from '$lib/components/charts/bar-list.svelte';
	import StageBar, { STAGE_STYLE } from '$lib/components/charts/stage-bar.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import { Activity, CircleAlert, FlaskConical } from '@lucide/svelte';

	let { result }: { result: ObservabilityResult } = $props();

	const d = $derived(result.status === 'ok' ? result.data : null);
	const t = $derived(d?.series.map((p) => p.t) ?? []);
	const step = $derived(d?.window.stepSeconds ?? 3600);

	let latencyLayer = $state<'gateway' | 'store'>('gateway');
	let routeLayer = $state<'gateway' | 'store'>('gateway');

	// A bucket with no requests has no latency or ratio: null breaks the line.
	const ratio = (num: number, den: number) => (den > 0 ? num / den : null);
	const latencyOf = (p: NonNullable<typeof d>['series'][number], q: 'p50' | 'p95' | 'p99') => {
		const v = p[latencyLayer][q];
		return v > 0 ? v : null;
	};

	const tot = $derived(d?.totals);
	const cacheable = $derived(tot ? tot.edgeHit + tot.edgeOrigin : 0);
	const errorRate5 = $derived(tot && tot.requests > 0 ? tot.errors5xx / tot.requests : 0);
	const routes = $derived((d?.routes ?? []).filter((r) => r.layer === routeLayer));

	const EDGE_LABEL = {
		hit: 'Served from the edge',
		origin: 'Fetched from origin',
		uncached: 'Not cacheable'
	} as const;
	const edgeTotal = $derived((d?.edge ?? []).reduce((s, e) => s + e.requests, 0));

	const reads = $derived(d?.reads);
	const narinfoTotal = $derived(
		reads ? reads.narinfo.hit + reads.narinfo.miss + reads.narinfo.upstream : 0
	);
</script>

{#if result.status === 'unconfigured'}
	<EmptyState
		icon={Activity}
		title="Connect Workers Analytics Engine"
		description="Request rates, latency percentiles, edge cache and D1 metrics are recorded already. To chart them here, set CF_ACCOUNT_ID and a CF_ANALYTICS_TOKEN with Account Analytics read access on this worker."
	/>
{:else if result.status === 'error'}
	<EmptyState
		icon={CircleAlert}
		title="Couldn't load metrics"
		description="The Analytics Engine query failed: {result.message}. Reload to try again."
	/>
{:else if d && tot}
	{#if result.sample}
		<div
			class="mb-6 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm"
			role="status"
		>
			<FlaskConical class="size-4 text-warning" />
			Sample data generated for local development. Set the Analytics Engine credentials to see real traffic.
		</div>
	{/if}

	<!-- Golden signals: traffic, errors, latency, plus the two cost levers. -->
	<div
		class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-(--shadow-panel) lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1"
	>
		<StatTile
			label="Requests"
			value={formatCompact(tot.requests)}
			sub={`${formatRate(tot.rps)} on average`}
		/>
		<StatTile
			label="Server errors"
			value={formatPct(errorRate5)}
			sub={`5xx responses; ${formatPct(tot.requests > 0 ? tot.errors4xx / tot.requests : 0)} were 4xx`}
			alert={errorRate5 > 0.01 ? 'Above 1%' : undefined}
		/>
		<StatTile
			label="p95 latency"
			value={formatMs(tot.p95)}
			sub={`p50 ${formatMs(tot.p50)}, p99 ${formatMs(tot.p99)}`}
		/>
		<StatTile
			label="Edge cache hits"
			value={formatPct(ratio(tot.edgeHit, cacheable))}
			sub={`${formatCompact(tot.edgeHit)} of ${formatCompact(cacheable)} cacheable responses`}
		/>
		<StatTile
			label="D1 on replicas"
			value={formatPct(ratio(tot.d1 - tot.d1Primary, tot.d1))}
			sub={`${formatCompact(tot.d1Primary)} of ${formatCompact(tot.d1)} statements hit the primary`}
		/>
	</div>

	<section class="mt-10">
		<SectionHead
			title="Traffic"
			description="Client requests at the gateway, including edge cache hits."
			class="mb-4"
		/>
		<div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
			<Panel title="Request rate">
				<TimeSeries
					{t}
					stepSeconds={step}
					format={formatRate}
					ariaLabel="Requests per second over time"
					series={[
						{
							key: 'rps',
							label: 'Requests',
							color: 'var(--viz-1)',
							values: d.series.map((p) => p.rps)
						}
					]}
				/>
			</Panel>
			<Panel title="Error rate">
				<TimeSeries
					{t}
					stepSeconds={step}
					format={(v) => formatPct(v)}
					ariaLabel="Share of requests that failed, over time"
					series={[
						{
							key: '5xx',
							label: '5xx',
							color: 'var(--destructive)',
							values: d.series.map((p) => ratio(p.errors5xx, p.requests))
						},
						{
							key: '4xx',
							label: '4xx',
							color: 'var(--warning)',
							values: d.series.map((p) => ratio(p.errors4xx, p.requests))
						}
					]}
				/>
			</Panel>
		</div>
	</section>

	<section class="mt-10">
		<SectionHead
			title="Latency"
			description="Time to response headers. Gateway is what clients see; store is the origin work behind an edge miss."
			class="mb-4"
		/>
		<Panel>
			<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 class="text-[0.9375rem] font-semibold">Percentiles</h3>
					<p class="text-xs text-muted-foreground">
						Log scale, so a tail spike doesn't flatten the median.
					</p>
				</div>
				<Segmented
					options={[
						['gateway', 'Gateway'],
						['store', 'Store']
					]}
					value={latencyLayer}
					onpick={(v) => (latencyLayer = v)}
					label="Layer"
				/>
			</div>
			<TimeSeries
				{t}
				stepSeconds={step}
				format={formatMs}
				scale="log"
				height={240}
				ariaLabel="Latency percentiles over time, log scale"
				series={[
					{
						key: 'p50',
						label: 'p50',
						color: 'var(--viz-ord-1)',
						values: d.series.map((p) => latencyOf(p, 'p50'))
					},
					{
						key: 'p95',
						label: 'p95',
						color: 'var(--viz-ord-2)',
						values: d.series.map((p) => latencyOf(p, 'p95'))
					},
					{
						key: 'p99',
						label: 'p99',
						color: 'var(--viz-ord-3)',
						values: d.series.map((p) => latencyOf(p, 'p99'))
					}
				]}
			/>
		</Panel>

		{#if d.edge.length > 0}
			<div class="table-frame mt-6">
				<table class="data-table">
					<thead>
						<tr>
							<th>Gateway responses</th>
							<th class="num">Share</th>
							<th class="num">p50</th>
							<th class="num">p95</th>
							<th class="num">p99</th>
						</tr>
					</thead>
					<tbody>
						{#each d.edge as e (e.verdict)}
							<tr>
								<td>{EDGE_LABEL[e.verdict]}</td>
								<td class="num">{formatPct(ratio(e.requests, edgeTotal))}</td>
								<td class="num">{formatMs(e.p50)}</td>
								<td class="num">{formatMs(e.p95)}</td>
								<td class="num">{formatMs(e.p99)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="mt-10">
		<SectionHead
			title="Edge cache"
			description="Of responses the edge could cache, how many it answered without running D1 or R2."
			class="mb-4"
		/>
		<div class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<Panel title="Hit rate">
				<TimeSeries
					{t}
					stepSeconds={step}
					format={(v) => formatPct(v, 0)}
					yMax={1}
					ariaLabel="Edge cache hit rate over time"
					series={[
						{
							key: 'hit',
							label: 'Hit rate',
							color: 'var(--viz-1)',
							values: d.series.map((p) => ratio(p.edgeHit, p.edgeHit + p.edgeOrigin))
						}
					]}
				/>
			</Panel>
			{#if reads}
				<Panel
					title="Lookups"
					description="Whether nix found a path in this cache, via an upstream, or not at all."
				>
					<dl class="grid grid-cols-1 gap-3 text-sm">
						{#each [['Found here', reads.narinfo.hit], ['Found upstream', reads.narinfo.upstream], ['Not found', reads.narinfo.miss]] as [label, n] (label)}
							<div
								class="flex items-baseline justify-between gap-3 border-b border-border/70 pb-2 last:border-0"
							>
								<dt class="text-muted-foreground">{label}</dt>
								<dd class="tabular-nums">
									{formatCompact(n as number)}
									<span class="ml-1.5 text-xs text-muted-foreground"
										>{formatPct(ratio(n as number, narinfoTotal))}</span
									>
								</dd>
							</div>
						{/each}
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">NARs downloaded</dt>
							<dd class="tabular-nums">{formatCompact(reads.nar.hit + reads.nar.upstream)}</dd>
						</div>
					</dl>
				</Panel>
			{/if}
		</div>
	</section>

	<section class="mt-10">
		<SectionHead
			title="Database"
			description="D1 statements from both layers. Reads should land on replicas; writes and read-your-write checks go to the primary."
			class="mb-4"
		/>
		<div class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<Panel title="Statements">
				<TimeSeries
					{t}
					stepSeconds={step}
					kind="stacked"
					format={formatRate}
					ariaLabel="D1 statements per second, replica and primary"
					series={[
						{
							key: 'replica',
							label: 'Replica',
							color: 'var(--viz-1)',
							values: d.series.map((p) => (p.d1 - p.d1Primary) / step)
						},
						{
							key: 'primary',
							label: 'Primary',
							color: 'var(--viz-2)',
							values: d.series.map((p) => p.d1Primary / step)
						}
					]}
				/>
			</Panel>
			<Panel
				title="Serving region"
				description="Where D1 answered, and how much of it was the primary."
			>
				{#if d.regions.length > 0}
					<BarList
						mono
						ariaLabel="D1 statements by serving region"
						format={formatCompact}
						rows={d.regions.map((r) => ({
							label: r.region,
							value: r.statements,
							detail: r.primaryShare > 0 ? `${formatPct(r.primaryShare)} primary` : 'replica only'
						}))}
					/>
				{:else}
					<p class="text-sm text-muted-foreground">No region data in this window yet.</p>
				{/if}
			</Panel>
		</div>
		<div
			class="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-(--shadow-panel) lg:grid-cols-4"
		>
			<StatTile
				label="Rows read"
				value={formatCompact(tot.rowsRead)}
				sub={`${(tot.requests > 0 ? tot.rowsRead / tot.requests : 0).toFixed(1)} per request`}
			/>
			<StatTile
				label="Rows written"
				value={formatCompact(tot.rowsWritten)}
				sub="Billed per indexed column"
			/>
			<StatTile
				label="SQL time"
				value={formatMs(tot.d1 > 0 ? tot.d1SqlMs / tot.d1 : 0)}
				sub="Mean per statement, as reported by D1"
			/>
			<StatTile
				label="R2 operations"
				value={formatCompact(tot.r2)}
				sub="Chunk and object reads and writes"
			/>
		</div>
	</section>

	<section class="mt-10">
		<div class="mb-4 flex flex-wrap items-end justify-between gap-3">
			<SectionHead
				title="Routes"
				description="Busiest first. The bar shows where a request's time goes, by stage."
			/>
			<Segmented
				options={[
					['gateway', 'Client-facing'],
					['store', 'Origin (store)']
				]}
				value={routeLayer}
				onpick={(v) => (routeLayer = v)}
				label="Layer"
			/>
		</div>
		<ul class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			{#each Object.values(STAGE_STYLE) as s (s.label)}
				<li class="inline-flex items-center gap-1.5">
					<span class="size-2.5 rounded-[3px]" style="background: {s.color}"></span>{s.label}
				</li>
			{/each}
		</ul>
		<div class="table-frame">
			<table class="data-table">
				<thead>
					<tr>
						<th>Route</th>
						<th class="num">Requests</th>
						<th class="num">Errors</th>
						<th class="num">p50</th>
						<th class="num">p95</th>
						<th class="num">p99</th>
						<th class="num">Edge hits</th>
						<th class="num">D1 per request</th>
						<th class="w-40">Time by stage</th>
					</tr>
				</thead>
				<tbody>
					{#each routes as r (r.route)}
						<tr>
							<td class="font-mono text-[0.8125rem] whitespace-nowrap">{r.route}</td>
							<td class="num">
								{formatCompact(r.requests)}
								<div class="text-xs text-muted-foreground">{formatRate(r.rps)}</div>
							</td>
							<td class="num {r.errorRate > 0.01 ? 'text-destructive' : ''}">
								{formatPct(r.errorRate)}
							</td>
							<td class="num">{formatMs(r.p50)}</td>
							<td class="num">{formatMs(r.p95)}</td>
							<td class="num">{formatMs(r.p99)}</td>
							<td class="num">{formatPct(r.edgeHitRate)}</td>
							<td class="num">
								{r.d1PerRequest.toFixed(1)}
								{#if r.primaryShare !== null && r.d1PerRequest > 0}
									<div class="text-xs text-muted-foreground">
										{formatPct(r.primaryShare, 0)} primary
									</div>
								{/if}
							</td>
							<td><StageBar stages={r.stages} total={r.meanMs} /></td>
						</tr>
					{:else}
						<tr
							><td colspan="9" class="py-8 text-center text-muted-foreground"
								>No requests in this window.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-10 grid grid-cols-1 gap-6 xl:grid-cols-2">
		<Panel
			title="Where requests come from"
			description="Cloudflare data centers, by gateway requests."
		>
			{#if d.colos.length > 0}
				<BarList
					mono
					ariaLabel="Requests by Cloudflare colo"
					format={formatCompact}
					rows={d.colos.map((c) => ({
						label: c.colo,
						value: c.requests,
						detail: `p95 ${formatMs(c.p95)}`
					}))}
				/>
			{:else}
				<p class="text-sm text-muted-foreground">No requests in this window.</p>
			{/if}
		</Panel>
		<Panel
			title="Writes and protection"
			description="What landed in storage, and what the rate limits turned away."
		>
			<dl class="grid grid-cols-1 gap-3 text-sm">
				{#each [['Paths pushed', `${formatCompact(d.pushes.stored + d.pushes.deduplicated)} (${formatPct(ratio(d.pushes.deduplicated, d.pushes.stored + d.pushes.deduplicated), 0)} already stored)`], ['Chunks written to R2', `${formatCompact(d.chunkWrites.stored)} (${formatBytes(d.chunkWrites.storedBytes)})`], ['Chunk writes avoided by dedup', `${formatCompact(d.chunkWrites.deduplicated)} (${formatBytes(d.chunkWrites.dedupBytes)})`], ['Abuse guard refusals', formatCompact(d.guards.probe + d.guards.verdict + d.guards.ingest)], ['Rate-limited API calls', formatCompact(d.rateLimited.api + d.rateLimited.mutation + d.rateLimited.gc)]] as [label, value] (label)}
					<div
						class="flex items-baseline justify-between gap-3 border-b border-border/70 pb-2 last:border-0"
					>
						<dt class="text-muted-foreground">{label}</dt>
						<dd class="text-right tabular-nums">{value}</dd>
					</div>
				{/each}
			</dl>
		</Panel>
	</section>
{/if}
