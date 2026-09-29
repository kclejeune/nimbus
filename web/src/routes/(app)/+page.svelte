<script lang="ts">
	import { formatBytes, formatCount, formatRelativeTime } from '$lib/format';
	import IngestChart from '$lib/components/ingest-chart.svelte';
	import UnifiedEndpointCard from '$lib/components/unified-endpoint-card.svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Recycle, TriangleAlert } from '@lucide/svelte';

	let { data } = $props();
	const s = $derived(data.stats);
	// GC status is admin-only; the controls themselves live on /settings.
	const isAdmin = $derived(data.user?.role === 'admin');

	// Bytes the store would hold without NAR- and chunk-level dedup, minus what
	// it actually holds.
	const dedupBytes = $derived(Math.max(0, s.logicalBytes - s.storageBytes));
	const dedupPct = $derived(
		s.logicalBytes > 0 ? Math.round((dedupBytes / s.logicalBytes) * 100) : 0
	);
	const usagePct = $derived(
		data.globalMaxBytes ? Math.round((s.storageBytes / data.globalMaxBytes) * 100) : null
	);
	// The storage bar's scale: the global limit when one is set, else the
	// logical (pre-dedup) size so the saved share is visible against it.
	const scale = $derived(Math.max(data.globalMaxBytes ?? 0, s.logicalBytes, s.storageBytes, 1));
	const storedW = $derived((s.storageBytes / scale) * 100);
	const savedW = $derived((dedupBytes / scale) * 100);

	const facts = $derived([
		{ label: 'Caches', value: formatCount(s.caches), href: '/caches' },
		{ label: 'Store paths', value: formatCount(s.objects), href: '/paths' },
		{ label: 'Unique NARs', value: formatCount(s.nars) },
		{ label: 'Pushed before dedup', value: formatBytes(s.logicalBytes) }
	]);

	const lastRun = $derived(data.gcLastRun);
	const gcIntegrityIssues = $derived(lastRun?.integrity?.incompleteObjects ?? 0);
</script>

<Page>
	<PageHeader title="Overview">
		{#snippet description()}
			Storage and ingest across every cache on this instance{#if data.statsAt}, as of the last
				garbage collection <span title={data.statsAt}>{formatRelativeTime(data.statsAt)}</span
				>{/if}.
		{/snippet}
	</PageHeader>

	<!-- Storage: the number people come here for, with dedup shown as the gap
	     between what was pushed and what is actually stored. -->
	<section
		aria-labelledby="storage-heading"
		class="overflow-hidden rounded-lg border bg-card shadow-(--shadow-panel)"
	>
		<div class="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-6 pt-6">
			<div>
				<h2 id="storage-heading" class="text-sm text-muted-foreground">Storage used</h2>
				<p class="mt-1 flex items-baseline gap-2">
					<span class="text-4xl font-semibold tracking-[-0.03em] tabular-nums">
						{formatBytes(s.storageBytes)}
					</span>
					{#if data.globalMaxBytes}
						<span class="text-sm text-muted-foreground">
							of {formatBytes(data.globalMaxBytes)} limit
						</span>
					{/if}
				</p>
			</div>
			{#if dedupBytes > 0}
				<div class="sm:text-right">
					<p class="text-sm text-muted-foreground">Saved by deduplication</p>
					<p class="mt-1 text-xl font-semibold tracking-[-0.02em] tabular-nums">
						{formatBytes(dedupBytes)}
						<span class="ml-1 text-sm font-medium text-success">{dedupPct}%</span>
					</p>
				</div>
			{/if}
		</div>

		<div class="px-6 pt-5 pb-6">
			<div
				class="flex h-2.5 overflow-hidden rounded-full bg-muted"
				role="img"
				aria-label="{formatBytes(s.storageBytes)} stored, {formatBytes(
					dedupBytes
				)} saved by deduplication"
			>
				<div
					class="h-full {usagePct != null && usagePct >= 90 ? 'bg-warning' : 'bg-primary'}"
					style="width: {storedW}%"
				></div>
				{#if savedW > 0}
					<div
						class="h-full border-l-2 border-card bg-[repeating-linear-gradient(135deg,var(--success)_0_2px,transparent_2px_6px)] opacity-60"
						style="width: {savedW}%"
					></div>
				{/if}
			</div>
			<div class="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
				<span class="inline-flex items-center gap-1.5">
					<span class="size-2 rounded-sm bg-primary"></span> Stored after dedup
				</span>
				{#if savedW > 0}
					<span class="inline-flex items-center gap-1.5">
						<span
							class="size-2 rounded-sm bg-[repeating-linear-gradient(135deg,var(--success)_0_1px,transparent_1px_3px)]"
						></span>
						Shared content, stored once
					</span>
				{/if}
				{#if usagePct != null}
					<span class="ms-auto tabular-nums">{usagePct}% of global limit</span>
				{/if}
			</div>
		</div>

		<dl class="grid grid-cols-2 border-t bg-subtle md:grid-cols-4">
			{#each facts as fact, i (fact.label)}
				<div
					class="border-border px-6 py-4 {i % 2 === 1 ? 'border-l' : ''} {i >= 2
						? 'border-t md:border-t-0'
						: ''} {i === 2 ? 'md:border-l' : ''}"
				>
					<dt class="text-xs text-muted-foreground">{fact.label}</dt>
					<dd class="mt-1 text-lg font-semibold tracking-[-0.01em] tabular-nums">
						{#if fact.href}
							<a href={fact.href} class="hover:text-primary">{fact.value}</a>
						{:else}
							{fact.value}
						{/if}
					</dd>
				</div>
			{/each}
		</dl>
	</section>

	{#if isAdmin}
		<!-- Status only; the GC and storage-limit controls live on /settings. -->
		<div
			class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-(--shadow-panel)"
		>
			<Recycle class="size-4 text-muted-foreground" />
			<span class="text-muted-foreground">
				{#if lastRun}
					Garbage collection last ran
					<span class="text-foreground" title={lastRun.at}>{formatRelativeTime(lastRun.at)}</span>
				{:else}
					Garbage collection hasn't run yet
				{/if}
			</span>
			{#if gcIntegrityIssues > 0}
				<span class="inline-flex items-center gap-1 text-warning">
					<TriangleAlert class="size-3.5" />
					{formatCount(gcIntegrityIssues)} incomplete
					{gcIntegrityIssues === 1 ? 'closure' : 'closures'}
				</span>
			{/if}
			<Button variant="ghost" size="sm" href="/settings" class="ms-auto">Manage</Button>
		</div>
	{/if}

	<div class="mt-8 grid gap-6">
		<IngestChart buckets={data.buckets} />

		{#if data.proxyPublicKey && data.cacheBaseUrl}
			<UnifiedEndpointCard
				url={data.cacheBaseUrl}
				publicKey={data.proxyPublicKey}
				upstreams={data.proxyUpstreams}
			/>
		{/if}
	</div>
</Page>
