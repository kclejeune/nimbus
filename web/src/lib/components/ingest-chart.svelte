<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
	import { scaleUtc } from 'd3-scale';
	import { curveMonotoneX } from 'd3-shape';
	import { Area, AreaChart } from 'layerchart';

	interface Bucket {
		/** ISO day. */
		date: string;
		paths: number;
		bytes: number;
	}

	let { buckets }: { buckets: Bucket[] } = $props();

	let timeRange = $state('90d');

	const ranges = [
		{ value: '90d', label: 'Last 3 months', days: 90 },
		{ value: '30d', label: 'Last 30 days', days: 30 },
		{ value: '7d', label: 'Last 7 days', days: 7 }
	];
	const selected = $derived(ranges.find((r) => r.value === timeRange) ?? ranges[0]);

	const chartData = $derived.by(() => {
		const cutoff = Date.now() - selected.days * 86400_000;
		return buckets
			.filter((b) => new Date(b.date).getTime() >= cutoff)
			.map((b) => ({ date: new Date(b.date), bytes: b.bytes, paths: b.paths }));
	});

	const totalBytes = $derived(chartData.reduce((sum, b) => sum + b.bytes, 0));
	const totalPaths = $derived(chartData.reduce((sum, b) => sum + b.paths, 0));

	const chartConfig = {
		bytes: { label: 'Ingested', color: 'var(--primary)' }
	} satisfies Chart.ChartConfig;
</script>

<Card.Root class="@container/card">
	<Card.Header>
		<Card.Title>Ingest</Card.Title>
		<Card.Description>
			{formatBytes(totalBytes)} across {formatCount(totalPaths)} paths pushed in the
			{selected.label.toLowerCase()}
		</Card.Description>
		<Card.Action>
			<ToggleGroup.Root
				type="single"
				bind:value={timeRange}
				variant="outline"
				class="hidden *:data-[slot=toggle-group-item]:!px-4 @[767px]/card:flex"
			>
				{#each ranges as range (range.value)}
					<ToggleGroup.Item value={range.value}>{range.label}</ToggleGroup.Item>
				{/each}
			</ToggleGroup.Root>
			<Select.Root type="single" bind:value={timeRange}>
				<Select.Trigger
					size="sm"
					class="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
					aria-label="Select a range"
				>
					<span data-slot="select-value">{selected.label}</span>
				</Select.Trigger>
				<Select.Content class="rounded-xl">
					{#each ranges as range (range.value)}
						<Select.Item value={range.value} class="rounded-lg">{range.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</Card.Action>
	</Card.Header>
	<Card.Content class="px-2 pt-4 sm:px-6 sm:pt-6">
		<Chart.Container config={chartConfig} class="aspect-auto h-[250px] w-full">
			<AreaChart
				data={chartData}
				x="date"
				xScale={scaleUtc()}
				series={[{ key: 'bytes', label: 'Ingested', color: chartConfig.bytes.color }]}
				props={{
					xAxis: {
						ticks: timeRange === '7d' ? 7 : undefined,
						format: (v: Date) => v.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
					},
					yAxis: { format: () => '' }
				}}
			>
				{#snippet marks({ context })}
					<defs>
						<linearGradient id="fillIngest" x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stop-color="var(--color-bytes)" stop-opacity={0.8} />
							<stop offset="95%" stop-color="var(--color-bytes)" stop-opacity={0.1} />
						</linearGradient>
					</defs>
					{#each context.series.visibleSeries as s (s.key)}
						<Area
							seriesKey={s.key}
							curve={curveMonotoneX}
							fillOpacity={0.4}
							line={{ class: 'stroke-1' }}
							motion="tween"
							{...s.props}
							fill="url(#fillIngest)"
						/>
					{/each}
				{/snippet}
				{#snippet tooltip()}
					<Chart.Tooltip
						labelFormatter={(v: Date) =>
							v.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
						indicator="line"
					>
						{#snippet formatter({ value })}
							<div class="flex w-full items-center justify-between gap-4">
								<span class="text-muted-foreground">Ingested</span>
								<span class="font-mono font-medium tabular-nums">
									{formatBytes(Number(value ?? 0))}
								</span>
							</div>
						{/snippet}
					</Chart.Tooltip>
				{/snippet}
			</AreaChart>
		</Chart.Container>
	</Card.Content>
</Card.Root>
