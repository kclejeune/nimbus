<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import { goto } from '$app/navigation';
	import AreaChart from '$lib/components/charts/area-chart.svelte';

	let { data } = $props();
	const b = $derived(data.buckets);

	const totalBytes = $derived(b.length ? b[b.length - 1].cumulativeBytes : 0);
	const totalPaths = $derived(b.length ? b[b.length - 1].cumulativePaths : 0);
	const peakBucket = $derived(
		b.reduce((m, w) => (w.paths > m.paths ? w : m), { paths: 0, date: '' })
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
		const params = new URLSearchParams();
		if (range !== 'all') params.set('range', range);
		if (granularity !== 'week') params.set('granularity', granularity);
		const qs = params.toString();
		goto(qs ? `?${qs}` : '?', { replaceState: true, noScroll: true, keepFocus: true });
	}
</script>

{#snippet segmented(options: [string, string][], active: string, pick: (v: string) => void)}
	<div class="inline-flex rounded-md border border-input p-0.5 text-xs">
		{#each options as [val, label] (val)}
			<button
				type="button"
				onclick={() => pick(val)}
				class="rounded px-2.5 py-1 transition-colors {active === val
					? 'bg-muted font-medium text-foreground'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				{label}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet stat(label: string, value: string, sub?: string)}
	<div class="rounded-lg border bg-card p-5">
		<div class="text-xs text-muted-foreground">{label}</div>
		<div class="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</div>
		{#if sub}<div class="mt-0.5 text-xs text-muted-foreground">{sub}</div>{/if}
	</div>
{/snippet}

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8 flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">Monitoring</h1>
			<p class="mt-1 text-sm text-muted-foreground">Storage and push activity over time.</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{@render segmented(RANGES, data.range, (v) => setParam({ range: v }))}
			{@render segmented(GRANULARITIES, data.granularity, (v) => setParam({ granularity: v }))}
		</div>
	</header>

	{#if b.length === 0}
		<div class="rounded-lg border border-dashed py-16 text-center">
			<p class="text-sm text-muted-foreground">No activity to chart yet.</p>
		</div>
	{:else}
		<div class="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
			{@render stat('Total storage', formatBytes(totalBytes))}
			{@render stat('Store paths', formatCount(totalPaths))}
			{@render stat(
				`Busiest ${unitWord}`,
				formatCount(peakBucket.paths),
				peakBucket.date ? `${peakBucket.date} · paths added` : undefined
			)}
		</div>

		<section class="mb-8 rounded-lg border bg-card p-5">
			<div class="mb-4 flex items-baseline justify-between">
				<h2 class="text-sm font-medium">Storage growth</h2>
				<span class="font-mono text-sm text-muted-foreground">{formatBytes(totalBytes)} total</span>
			</div>
			<AreaChart
				points={storagePoints}
				format={formatBytes}
				deltaFormat={formatBytes}
				deltaLabel={perLabel}
				ariaLabel="Cumulative storage over time"
			/>
		</section>

		<section class="rounded-lg border bg-card p-5">
			<div class="mb-4 flex items-baseline justify-between">
				<h2 class="text-sm font-medium">Store paths</h2>
				<span class="font-mono text-sm text-muted-foreground">{formatCount(totalPaths)} total</span>
			</div>
			<AreaChart
				points={pathPoints}
				format={formatCount}
				deltaFormat={formatCount}
				deltaLabel={perLabel}
				ariaLabel="Cumulative store paths over time"
			/>
		</section>
	{/if}
</div>
