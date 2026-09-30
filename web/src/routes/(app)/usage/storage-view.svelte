<script lang="ts">
	import Segmented from '$lib/components/layout/segmented.svelte';
	import StatTile from './stat-tile.svelte';
	import SectionHead from './section-head.svelte';
	import type { PageData } from './$types';
	type StorageData = NonNullable<Extract<PageData, { view: 'storage' }>['storage']>;
	import { formatBytes, formatCount, formatRelativeTime, storageSavings } from '$lib/format';
	import { replaceQuery } from '$lib/url-state';
	import AreaChart from '$lib/components/charts/area-chart.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import { ChartLine } from '@lucide/svelte';

	let { storage: data }: { storage: StorageData } = $props();
	const b = $derived(data.buckets);

	const totalBytes = $derived(b.length ? b[b.length - 1].cumulativeBytes : 0);
	const totalPaths = $derived(b.length ? b[b.length - 1].cumulativePaths : 0);
	const peakBucket = $derived(
		b.reduce((m, w) => (w.paths > m.paths ? w : m), { paths: 0, date: '' })
	);

	// Instance stats, shared with the Overview tiles.
	const stats = $derived(data.stats);
	const { dedupBytes, dedupPct, usagePct } = $derived(storageSavings(stats, data.globalMaxBytes));

	const storagePoints = $derived(
		b.map((w) => ({ label: w.date, value: w.cumulativeBytes, delta: w.bytes }))
	);
	const pathPoints = $derived(
		b.map((w) => ({ label: w.date, value: w.cumulativePaths, delta: w.paths }))
	);

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
		const params = new URLSearchParams({ view: 'storage' });
		if (range !== 'all') params.set('range', range);
		if (granularity !== 'week') params.set('granularity', granularity);
		replaceQuery(params);
	}
</script>

<!-- Stats sit in one ruled grid per section (gap-px over the border color draws
     the dividers) rather than a field of separate cards. -->
{#snippet chartPanel(title: string, total: string)}
	<div class="mb-4 flex items-baseline justify-between gap-3">
		<h3 class="text-[0.9375rem] font-semibold">{title}</h3>
		<span class="text-sm whitespace-nowrap text-muted-foreground tabular-nums">{total}</span>
	</div>
{/snippet}

<section>
	<div class="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
		<SectionHead title="Storage" description="Paths pushed and bytes stored over time." />
		<!-- Scoped here: these controls window the storage series only. -->
		<div class="flex flex-wrap items-center gap-2">
			<Segmented
				options={RANGES}
				value={data.range}
				onpick={(v) => setParam({ range: v })}
				label="Time range"
			/>
			<Segmented
				options={GRANULARITIES}
				value={data.granularity}
				onpick={(v) => setParam({ granularity: v })}
				label="Granularity"
			/>
		</div>
	</div>

	{#if b.length === 0}
		<EmptyState
			icon={ChartLine}
			title="Nothing pushed yet"
			description="Charts fill in once a path is pushed to a cache."
		/>
	{:else}
		<div
			class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-(--shadow-panel) lg:grid-cols-3"
		>
			<StatTile
				label="Storage used"
				value={formatBytes(stats.storageBytes)}
				sub={data.globalMaxBytes
					? `${usagePct}% of ${formatBytes(data.globalMaxBytes)} global limit`
					: 'After dedup. No global limit.'}
			/>
			<StatTile label="Store paths" value={formatCount(stats.objects)} sub="Across all caches" />
			<StatTile label="Caches" value={formatCount(stats.caches)} />
			<StatTile
				label="Unique NARs"
				value={formatCount(stats.nars)}
				sub="Identical content is stored once"
			/>
			<StatTile
				label="Deduplication"
				value={dedupBytes > 0 ? `${dedupPct}%` : '—'}
				sub={dedupBytes > 0 ? `${formatBytes(dedupBytes)} saved` : 'Nothing shared yet'}
			/>
			<StatTile
				label={`Busiest ${data.granularity}`}
				value={formatCount(peakBucket.paths)}
				sub={peakBucket.date
					? `Paths added in the ${data.granularity} of ${peakBucket.date}`
					: undefined}
			/>
		</div>
		{#if data.statsAt}
			<p class="mt-2 text-xs text-muted-foreground">
				Totals as of last GC, {formatRelativeTime(data.statsAt)}.
			</p>
		{/if}

		<div class="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
			<Panel>
				{@render chartPanel('Storage growth', `${formatBytes(totalBytes)} total`)}
				<AreaChart
					points={storagePoints}
					format={formatBytes}
					deltaFormat={formatBytes}
					deltaLabel="this {data.granularity}"
					ariaLabel="Cumulative storage over time"
				/>
			</Panel>
			<Panel>
				{@render chartPanel('Store paths', `${formatCount(totalPaths)} total`)}
				<AreaChart
					points={pathPoints}
					format={formatCount}
					deltaFormat={formatCount}
					deltaLabel="this {data.granularity}"
					ariaLabel="Cumulative store paths over time"
				/>
			</Panel>
		</div>
	{/if}
</section>
