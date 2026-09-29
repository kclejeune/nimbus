<script lang="ts">
	import type { PageData } from './$types';
	type StorageData = NonNullable<Extract<PageData, { view: 'storage' }>['storage']>;
	import { formatBytes, formatCount, formatRelativeTime } from '$lib/format';
	import { goto } from '$app/navigation';
	import AreaChart from '$lib/components/charts/area-chart.svelte';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
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
		const params = new URLSearchParams({ view: 'storage' });
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

<section>
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
