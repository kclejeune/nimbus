<script lang="ts">
	import { formatBytes, formatCount, formatRelativeTime } from '$lib/format';
	import { goto } from '$app/navigation';
	import AreaChart from '$lib/components/charts/area-chart.svelte';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import { Activity, ChartLine } from '@lucide/svelte';

	let { data } = $props();
	const b = $derived(data.buckets);

	const totalBytes = $derived(b.length ? b[b.length - 1].cumulativeBytes : 0);
	const totalPaths = $derived(b.length ? b[b.length - 1].cumulativePaths : 0);
	const peakBucket = $derived(
		b.reduce((m, w) => (w.paths > m.paths ? w : m), { paths: 0, date: '' })
	);

	// Instance stats, shared with the Overview tiles.
	const stats = $derived(data.stats);
	const dedupBytes = $derived(Math.max(0, stats.logicalBytes - stats.storageBytes));
	const dedupPct = $derived(
		stats.logicalBytes > 0 ? Math.round((dedupBytes / stats.logicalBytes) * 100) : 0
	);
	const usagePct = $derived(
		data.globalMaxBytes ? Math.round((stats.storageBytes / data.globalMaxBytes) * 100) : null
	);

	const storagePoints = $derived(
		b.map((w) => ({ label: w.date, value: w.cumulativeBytes, delta: w.bytes }))
	);
	const pathPoints = $derived(
		b.map((w) => ({ label: w.date, value: w.cumulativePaths, delta: w.paths }))
	);

	const traffic = $derived(data.traffic);
	const trafficRequests = $derived(
		traffic
			? traffic.narinfo.hit +
					traffic.narinfo.miss +
					traffic.narinfo.upstream +
					traffic.nar.hit +
					traffic.nar.miss +
					traffic.nar.upstream
			: 0
	);
	// Hit rate over narinfo lookups: the request nix actually fans out, and the
	// one that decides whether this cache was useful. `hit` excludes upstream
	// passthroughs, so this is genuinely "answered from local storage".
	const narinfoLookups = $derived(
		traffic ? traffic.narinfo.hit + traffic.narinfo.miss + traffic.narinfo.upstream : 0
	);
	const hitRate = $derived(
		narinfoLookups > 0 ? Math.round((100 * traffic!.narinfo.hit) / narinfoLookups) : null
	);
	// Edge-cache effectiveness: of the reads that reached a cacheable store
	// fetch, how many the edge answered without touching D1 or R2.
	const edgeLookups = $derived(traffic ? traffic.edge.hit + traffic.edge.origin : 0);
	const edgeHitRate = $derived(
		edgeLookups > 0 ? Math.round((100 * traffic!.edge.hit) / edgeLookups) : null
	);
	const trafficPoints = $derived(
		(traffic?.days ?? []).map((d) => ({
			label: d.date,
			value: d.hit + d.miss + d.upstream,
			delta: d.hit + d.miss + d.upstream
		}))
	);
	const edgePoints = $derived(
		(traffic?.edgeDays ?? []).map((d) => ({ label: d.date, value: d.hit, delta: d.hit }))
	);

	const pushTotal = $derived(traffic ? traffic.push.stored + traffic.push.deduplicated : 0);
	// Share of pushed paths that needed no new NAR — dedup working at push time.
	const pushDedupPct = $derived(
		pushTotal > 0 ? Math.round((100 * traffic!.push.deduplicated) / pushTotal) : null
	);
	const pushPoints = $derived(
		(traffic?.pushDays ?? []).map((d) => ({
			label: d.date,
			value: d.stored + d.deduplicated,
			delta: d.stored + d.deduplicated
		}))
	);

	// Chunk-level storage writes: what actually lands in R2 (incl. pull-through).
	const writes = $derived(traffic?.writes);
	const chunkTotal = $derived(writes ? writes.stored + writes.deduplicated : 0);
	const chunkDedupPct = $derived(
		writes && chunkTotal > 0 ? Math.round((100 * writes.deduplicated) / chunkTotal) : null
	);
	const writePoints = $derived(
		(traffic?.writeDays ?? []).map((d) => ({
			label: d.date,
			value: d.storedBytes,
			delta: d.storedBytes
		}))
	);

	// Abuse-guard refusals: nonzero means the rate budgets are actively
	// deflecting probe/verdict/ingest amplification.
	const guardTotal = $derived(
		traffic ? traffic.guards.probe + traffic.guards.verdict + traffic.guards.ingest : 0
	);

	const unitWord = $derived(
		data.granularity === 'day' ? 'day' : data.granularity === 'month' ? 'month' : 'week'
	);
	const perLabel = $derived(`this ${unitWord}`);

	const RANGES: [string, string][] = [
		['30d', '30d'],
		['90d', '90d'],
		['6m', '6m'],
		['1y', '1y'],
		['all', 'All']
	];
	const GRANULARITIES: [string, string][] = [
		['day', 'Day'],
		['week', 'Week'],
		['month', 'Month']
	];

	function setParam(next: { range?: string; granularity?: string }) {
		const range = next.range ?? data.range;
		const granularity = next.granularity ?? data.granularity;
		const params = new URLSearchParams();
		if (range !== 'all') params.set('range', range);
		if (granularity !== 'week') params.set('granularity', granularity);
		const qs = params.toString();
		goto(qs ? `?${qs}` : '?', { replaceState: true, noScroll: true, keepFocus: true });
	}
</script>

{#snippet segmented(
	options: [string, string][],
	active: string,
	pick: (v: string) => void,
	label: string
)}
	<!-- Single-select toggle groups deselect on a second click; ignore the
	     resulting empty value so one option is always active. -->
	<ToggleGroup.Root
		type="single"
		value={active}
		onValueChange={(v) => v && pick(v)}
		variant="outline"
		size="sm"
		aria-label={label}
		class="bg-background shadow-(--shadow-panel)"
	>
		{#each options as [val, label] (val)}
			<ToggleGroup.Item value={val} class="!px-3 text-xs">{label}</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>
{/snippet}

<!-- Stats sit in one ruled grid per section (gap-px over the border color draws
     the dividers) rather than a field of separate cards. -->
{#snippet stat(label: string, value: string, sub?: string)}
	<div class="bg-card px-5 py-4">
		<div class="text-xs text-muted-foreground">{label}</div>
		<div class="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
		{#if sub}<div class="mt-1 text-xs leading-snug text-muted-foreground">{sub}</div>{/if}
	</div>
{/snippet}

{#snippet chartPanel(title: string, total: string)}
	<div class="mb-4 flex items-baseline justify-between gap-3">
		<h3 class="text-[0.9375rem] font-semibold">{title}</h3>
		<span class="text-sm whitespace-nowrap text-muted-foreground tabular-nums">{total}</span>
	</div>
{/snippet}

{#snippet sectionHead(title: string, description: string)}
	<div>
		<h2 class="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
		<p class="mt-0.5 text-sm text-muted-foreground">{description}</p>
	</div>
{/snippet}

<Page>
	<PageHeader
		title="Monitoring"
		description="Storage growth and cache traffic across every cache on this instance."
	/>

	<section class="mb-12">
		<div class="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
			{@render sectionHead('Storage', 'Paths pushed and bytes stored over time.')}
			<!-- Scoped here: these controls window the storage series only. -->
			<div class="flex flex-wrap items-center gap-2">
				{@render segmented(RANGES, data.range, (v) => setParam({ range: v }), 'Time range')}
				{@render segmented(
					GRANULARITIES,
					data.granularity,
					(v) => setParam({ granularity: v }),
					'Granularity'
				)}
			</div>
		</div>

		{#if b.length === 0}
			<EmptyState
				icon={ChartLine}
				title="No activity to chart yet"
				description="Storage growth appears here once paths are pushed to a cache."
			/>
		{:else}
			<div
				class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-(--shadow-panel) lg:grid-cols-3"
			>
				{@render stat(
					'Storage used',
					formatBytes(stats.storageBytes),
					data.globalMaxBytes
						? `${usagePct}% of the ${formatBytes(data.globalMaxBytes)} global limit`
						: 'Physical bytes after dedup, no global limit set'
				)}
				{@render stat('Store paths', formatCount(stats.objects), 'Across all caches')}
				{@render stat('Caches', formatCount(stats.caches), 'Isolated views into shared storage')}
				{@render stat(
					'Unique NARs',
					formatCount(stats.nars),
					'Store paths with identical content share one NAR'
				)}
				{@render stat(
					'Deduplication',
					dedupBytes > 0 ? `${dedupPct}%` : '—',
					dedupBytes > 0 ? `${formatBytes(dedupBytes)} saved` : 'Nothing shared yet'
				)}
				{@render stat(
					`Busiest ${unitWord}`,
					formatCount(peakBucket.paths),
					peakBucket.date ? `Paths added in the ${unitWord} of ${peakBucket.date}` : undefined
				)}
			</div>
			{#if data.statsAt}
				<p class="mt-2 text-xs text-muted-foreground">
					Storage totals as of the last garbage collection, {formatRelativeTime(data.statsAt)}.
				</p>
			{/if}

			<div class="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
				<Panel>
					{@render chartPanel('Storage growth', `${formatBytes(totalBytes)} total`)}
					<AreaChart
						points={storagePoints}
						format={formatBytes}
						deltaFormat={formatBytes}
						deltaLabel={perLabel}
						ariaLabel="Cumulative storage over time"
					/>
				</Panel>
				<Panel>
					{@render chartPanel('Store paths', `${formatCount(totalPaths)} total`)}
					<AreaChart
						points={pathPoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel={perLabel}
						ariaLabel="Cumulative store paths over time"
					/>
				</Panel>
			</div>
		{/if}
	</section>

	<section>
		<div class="mb-4">
			{@render sectionHead(
				'Traffic',
				'Reads and pushes over the last 30 days, from Workers Analytics Engine.'
			)}
		</div>

		{#if traffic}
			<div
				class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-(--shadow-panel) lg:grid-cols-4"
			>
				{@render stat(
					'Local hit rate',
					hitRate === null ? '—' : `${hitRate}%`,
					'narinfo lookups answered from local storage'
				)}
				{@render stat(
					'Edge cache',
					edgeHitRate === null ? '—' : `${edgeHitRate}%`,
					'Reads served from the edge cache, skipping D1 and R2'
				)}
				{@render stat('narinfo hits', formatCount(traffic.narinfo.hit), 'Last 30 days')}
				{@render stat(
					'Misses',
					formatCount(traffic.narinfo.miss + traffic.nar.miss),
					'Not local, not upstream'
				)}
				{@render stat(
					'Upstream',
					formatCount(traffic.narinfo.upstream + traffic.nar.upstream),
					'Answered via upstream caches'
				)}
				{@render stat('NARs served', formatCount(traffic.nar.hit), 'Downloads from local storage')}
				{@render stat('Paths pushed', formatCount(pushTotal), 'Last 30 days')}
				{@render stat(
					'Push dedup',
					pushDedupPct === null ? '—' : `${pushDedupPct}%`,
					'Pushes reusing an already-stored NAR'
				)}
				{@render stat('Pushed data', formatBytes(traffic.push.bytes), 'NAR bytes before dedup')}
				{@render stat(
					'Data written',
					writes ? formatBytes(writes.storedBytes) : '—',
					writes
						? `${formatCount(writes.stored)} chunks into R2, including pull-through`
						: 'No chunk writes recorded yet'
				)}
				{@render stat(
					'Chunk dedup',
					chunkDedupPct === null ? '—' : `${chunkDedupPct}%`,
					writes && writes.dedupBytes > 0
						? `${formatBytes(writes.dedupBytes)} avoided by chunk reuse`
						: 'Chunks matching already-stored content'
				)}
				{@render stat(
					'Deflected',
					formatCount(guardTotal),
					guardTotal > 0
						? `Abuse-guard refusals: ${formatCount(traffic.guards.probe)} probes, ${formatCount(traffic.guards.verdict)} verdicts, ${formatCount(traffic.guards.ingest)} ingests`
						: 'Abuse-guard refusals (probes, verdict writes, ingests)'
				)}
			</div>

			<div class="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
				<Panel>
					{@render chartPanel('Read traffic', `${formatCount(trafficRequests)} reads in 30 days`)}
					<AreaChart
						points={trafficPoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel="this day"
						ariaLabel="Read requests per day"
					/>
				</Panel>
				<Panel>
					{@render chartPanel(
						'Edge cache hits',
						`${formatCount(traffic.edge.hit)} reads in 30 days`
					)}
					<AreaChart
						points={edgePoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel="this day"
						ariaLabel="Edge cache hits per day"
					/>
				</Panel>
				<Panel>
					{@render chartPanel('Push traffic', `${formatCount(pushTotal)} paths in 30 days`)}
					<AreaChart
						points={pushPoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel="this day"
						ariaLabel="Paths pushed per day"
					/>
				</Panel>
				<Panel>
					{@render chartPanel(
						'Data written',
						`${writes ? formatBytes(writes.storedBytes) : '—'} in 30 days`
					)}
					<AreaChart
						points={writePoints}
						format={formatBytes}
						deltaFormat={formatBytes}
						deltaLabel="this day"
						ariaLabel="Bytes written to storage per day"
					/>
				</Panel>
			</div>
		{:else}
			<EmptyState
				icon={Activity}
				title="Traffic metrics aren't connected"
				description="Set the CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN secrets to chart cache reads, pushes, hit rate and upstream fetches here."
			/>
		{/if}
	</section>
</Page>
