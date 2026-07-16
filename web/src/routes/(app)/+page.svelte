<script lang="ts">
	import { formatBytes, formatCount, formatRelativeTime } from '$lib/format';
	import IngestChart from '$lib/components/ingest-chart.svelte';
	import UnifiedEndpointCard from '$lib/components/unified-endpoint-card.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { TriangleAlert } from '@lucide/svelte';

	let { data } = $props();
	const s = $derived(data.stats);
	// GC status is admin-only; the controls themselves live on /settings.
	const isAdmin = $derived(data.user?.role === 'admin');

	const usagePct = $derived(
		data.globalMaxBytes ? Math.round((s.storageBytes / data.globalMaxBytes) * 100) : null
	);

	// Bytes the store would hold without NAR- and chunk-level dedup, minus what
	// it actually holds.
	const dedupBytes = $derived(Math.max(0, s.logicalBytes - s.storageBytes));
	const dedupPct = $derived(
		s.logicalBytes > 0 ? Math.round((dedupBytes / s.logicalBytes) * 100) : 0
	);

	const tiles = $derived([
		{
			label: 'Caches',
			value: formatCount(s.caches),
			foot: 'Isolated views into shared storage'
		},
		{
			label: 'Store paths',
			value: formatCount(s.objects),
			foot: 'Across all caches'
		},
		{
			label: 'NARs stored',
			value: formatCount(s.nars),
			foot:
				dedupBytes > 0
					? `${formatBytes(dedupBytes)} saved by deduplication`
					: 'Store paths with identical content share one NAR',
			badge: dedupBytes > 0 ? `−${dedupPct}%` : null
		},
		{
			label: 'Storage used',
			value: formatBytes(s.storageBytes),
			foot: data.globalMaxBytes
				? `Physical bytes after dedup, of a ${formatBytes(data.globalMaxBytes)} global limit`
				: 'Physical bytes after dedup · no global limit set',
			badge: usagePct != null ? `${usagePct}%` : null
		}
	]);

	const lastRun = $derived(data.gcLastRun);
	const gcIntegrityIssues = $derived(lastRun?.integrity?.incompleteObjects ?? 0);
</script>

<div
	class="@container/main mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6 md:gap-6 lg:px-8 lg:py-8"
>
	<div
		class="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card"
	>
		{#each tiles as tile (tile.label)}
			<Card.Root class="@container/card">
				<Card.Header>
					<Card.Description>{tile.label}</Card.Description>
					<Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
						{tile.value}
					</Card.Title>
					{#if tile.badge}
						<Card.Action>
							<Badge variant="outline">{tile.badge}</Badge>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Footer class="text-sm text-muted-foreground">
					{tile.foot}
				</Card.Footer>
			</Card.Root>
		{/each}
	</div>

	{#if data.proxyPublicKey && data.cacheBaseUrl}
		<UnifiedEndpointCard
			url={data.cacheBaseUrl}
			publicKey={data.proxyPublicKey}
			upstreams={data.proxyUpstreams}
		/>
	{/if}

	<IngestChart buckets={data.buckets} />

	{#if isAdmin}
		<!-- Status only; the GC and storage-limit controls live on /settings. -->
		<p class="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
			{#if lastRun}
				Garbage collection last ran
				<span title={lastRun.at}>{formatRelativeTime(lastRun.at)}</span>
				{#if gcIntegrityIssues > 0}
					<span class="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
						<TriangleAlert class="size-3.5" />
						{formatCount(gcIntegrityIssues)} incomplete
						{gcIntegrityIssues === 1 ? 'closure' : 'closures'}
					</span>
				{/if}
			{:else}
				Garbage collection hasn't run yet
			{/if}
			· <a href="/settings" class="text-foreground hover:underline">manage in Settings</a>
		</p>
	{/if}
</div>
