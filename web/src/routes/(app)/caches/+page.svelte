<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import { Boxes, Plus, Lock, Globe } from '@lucide/svelte';

	let { data } = $props();
</script>

{#snippet size(bytes: number, budget: number | null)}
	{#if budget}
		{@const pct = (bytes / budget) * 100}
		<div class="flex flex-col items-end gap-1.5">
			<span>
				{formatBytes(bytes)}
				<span class="text-muted-foreground">/ {formatBytes(budget)}</span>
			</span>
			<div
				class="h-1 w-28 overflow-hidden rounded-full bg-muted"
				title="{Math.round(pct)}% of size budget"
			>
				<div
					class="h-full rounded-full {pct >= 90 ? 'bg-warning' : 'bg-primary'}"
					style="width: {Math.min(100, pct)}%"
				></div>
			</div>
		</div>
	{:else}
		{formatBytes(bytes)}
	{/if}
{/snippet}

<Page>
	<PageHeader
		title="Caches"
		description="Each cache has its own signing key, access and retention."
	>
		{#snippet actions()}
			<Button href="/caches/new">
				<Plus />
				New cache
			</Button>
		{/snippet}
	</PageHeader>

	{#if data.caches.length === 0}
		<EmptyState
			icon={Boxes}
			title="No caches yet"
			description="Push to a cache with the nimbus CLI or attic."
		>
			{#snippet action()}
				<Button href="/caches/new"><Plus /> New cache</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="table-frame">
			<table class="data-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Visibility</th>
						<th class="num">Paths</th>
						<th class="num" title="Deduplicated NAR bytes"> Size </th>
						<th>Compression</th>
						<th class="num">Priority</th>
						<th>Retention</th>
					</tr>
				</thead>
				<tbody>
					{#each data.caches as cache (cache.name)}
						<tr>
							<td>
								<a href="/caches/{cache.name}" class="row-link font-mono text-[0.8125rem]">
									{cache.name}
								</a>
							</td>
							<td>
								{#if cache.isPublic}
									<StatusBadge tone="primary"><Globe class="size-3" /> Public</StatusBadge>
								{:else}
									<StatusBadge><Lock class="size-3" /> Private</StatusBadge>
								{/if}
							</td>
							<td class="num">{formatCount(cache.objects)}</td>
							<td class="num">
								{#await data.storageBytes}
									<Skeleton class="ml-auto h-4 w-16" aria-label="Loading size" />
								{:then sizes}
									{@render size(sizes[cache.name] ?? 0, cache.retentionMaxBytes)}
								{/await}
							</td>
							<td class="font-mono text-[0.8125rem] text-muted-foreground">{cache.compression}</td>
							<td class="num">{cache.priority}</td>
							<td class="text-muted-foreground">
								{cache.retentionDays ? `${cache.retentionDays} days` : 'Forever'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="mt-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
			Shared chunks count toward every cache that references them, so sizes can total more than
			physical storage.
		</p>
	{/if}
</Page>
