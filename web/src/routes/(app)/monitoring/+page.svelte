<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import { goto } from '$app/navigation';
	import AreaChart from '$lib/components/charts/area-chart.svelte';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';

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
	// one that decides whether this cache was useful.
	const narinfoLookups = $derived(
		traffic ? traffic.narinfo.hit + traffic.narinfo.miss + traffic.narinfo.upstream : 0
	);
	const hitRate = $derived(
		narinfoLookups > 0 ? Math.round((100 * traffic!.narinfo.hit) / narinfoLookups) : null
	);
	const trafficPoints = $derived(
		(traffic?.days ?? []).map((d) => ({
			label: d.date,
			value: d.hit + d.miss + d.upstream,
			delta: d.hit + d.miss + d.upstream
		}))
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
	<!-- Single-select toggle groups deselect on a second click; ignore the
	     resulting empty value so one option is always active. -->
	<ToggleGroup.Root
		type="single"
		value={active}
		onValueChange={(v) => v && pick(v)}
		variant="outline"
		size="sm"
	>
		{#each options as [val, label] (val)}
			<ToggleGroup.Item value={val} class="!px-3 text-xs">{label}</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>
{/snippet}

{#snippet stat(label: string, value: string, sub?: string, cls?: string)}
	<div class="rounded-lg border bg-card p-5 {cls ?? ''}">
		<div class="text-xs text-muted-foreground">{label}</div>
		<div class="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</div>
		{#if sub}<div class="mt-0.5 text-xs text-muted-foreground">{sub}</div>{/if}
	</div>
{/snippet}

{#snippet chartCard(title: string, total: string)}
	<div class="mb-4 flex items-baseline justify-between gap-3">
		<h3 class="text-sm font-medium">{title}</h3>
		<span class="font-mono text-sm whitespace-nowrap text-muted-foreground">{total}</span>
	</div>
{/snippet}

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Monitoring</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Storage growth and cache traffic across all caches.
		</p>
	</header>

	<!-- Each section is a header, a stat-card grid, and a chart grid; a new
	     metric is one more card flowing into its grid, not a longer page. -->
	<section class="mb-10">
		<div class="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
			<div>
				<h2 class="text-base font-semibold tracking-tight">Storage</h2>
				<p class="mt-0.5 text-xs text-muted-foreground">Paths pushed and bytes stored over time.</p>
			</div>
			<!-- Scoped here: these controls window the storage series only. -->
			<div class="flex flex-wrap items-center gap-2">
				{@render segmented(RANGES, data.range, (v) => setParam({ range: v }))}
				{@render segmented(GRANULARITIES, data.granularity, (v) => setParam({ granularity: v }))}
			</div>
		</div>

		{#if b.length === 0}
			<div class="rounded-lg border border-dashed py-16 text-center">
				<p class="text-sm text-muted-foreground">No activity to chart yet.</p>
			</div>
		{:else}
			<div class="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
				{@render stat('Total storage', formatBytes(totalBytes))}
				{@render stat('Store paths', formatCount(totalPaths))}
				{@render stat(
					`Busiest ${unitWord}`,
					formatCount(peakBucket.paths),
					peakBucket.date ? `${peakBucket.date} · paths added` : undefined,
					// Odd card out in the two-column mobile grid: span the full row.
					'col-span-2 lg:col-span-1'
				)}
			</div>

			<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
				<div class="rounded-lg border bg-card p-5">
					{@render chartCard('Storage growth', `${formatBytes(totalBytes)} total`)}
					<AreaChart
						points={storagePoints}
						format={formatBytes}
						deltaFormat={formatBytes}
						deltaLabel={perLabel}
						ariaLabel="Cumulative storage over time"
					/>
				</div>
				<div class="rounded-lg border bg-card p-5">
					{@render chartCard('Store paths', `${formatCount(totalPaths)} total`)}
					<AreaChart
						points={pathPoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel={perLabel}
						ariaLabel="Cumulative store paths over time"
					/>
				</div>
			</div>
		{/if}
	</section>

	<section>
		<div class="mb-4">
			<h2 class="text-base font-semibold tracking-tight">Traffic</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">
				Reads and pushes over the last 30 days, from Workers Analytics Engine.
			</p>
		</div>

		{#if traffic}
			<div class="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
				{@render stat(
					'Hit rate',
					hitRate === null ? '—' : `${hitRate}%`,
					'narinfo lookups answered locally'
				)}
				{@render stat('narinfo hits', formatCount(traffic.narinfo.hit), 'last 30 days')}
				{@render stat(
					'Misses',
					formatCount(traffic.narinfo.miss + traffic.nar.miss),
					'not local, not upstream'
				)}
				{@render stat(
					'Upstream',
					formatCount(traffic.narinfo.upstream + traffic.nar.upstream),
					'answered via upstream caches'
				)}
				{@render stat('Paths pushed', formatCount(pushTotal), 'last 30 days')}
				{@render stat(
					'Push dedup',
					pushDedupPct === null ? '—' : `${pushDedupPct}%`,
					'pushes reusing an already-stored NAR'
				)}
				{@render stat(
					'Pushed data',
					formatBytes(traffic.push.bytes),
					'NAR bytes before dedup',
					// Odd card out in the two-column mobile grid: span the full row.
					'col-span-2 lg:col-span-1'
				)}
			</div>

			<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
				<div class="rounded-lg border bg-card p-5">
					{@render chartCard('Read traffic', `${formatCount(trafficRequests)} reads · 30 days`)}
					<AreaChart
						points={trafficPoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel="this day"
						ariaLabel="Read requests per day"
					/>
				</div>
				<div class="rounded-lg border bg-card p-5">
					{@render chartCard('Push traffic', `${formatCount(pushTotal)} paths · 30 days`)}
					<AreaChart
						points={pushPoints}
						format={formatCount}
						deltaFormat={formatCount}
						deltaLabel="this day"
						ariaLabel="Paths pushed per day"
					/>
				</div>
			</div>
		{:else}
			<div class="rounded-lg border border-dashed px-6 py-12 text-center">
				<p class="text-sm text-muted-foreground">Traffic metrics aren't connected.</p>
				<p class="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
					Set the <code class="font-mono">CF_ACCOUNT_ID</code> and
					<code class="font-mono">CF_ANALYTICS_TOKEN</code> secrets to chart cache reads, pushes, hit
					rate, and upstream fetches here.
				</p>
			</div>
		{/if}
	</section>
</div>
