<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import { Boxes, Plus, Lock, Globe } from '@lucide/svelte';

	let { data } = $props();
</script>

<Page>
	<PageHeader
		title="Caches"
		description="Each cache is an isolated view into the shared content-addressed store, with its own signing key, access list and retention."
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
			title="Create your first cache"
			description="A cache gets its own substituter URL and signing key. Push to it with the nimbus CLI or attic."
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
						<th
							class="num"
							title="NAR bytes attributed to this cache; content shared with other NARs or caches counts in each"
						>
							Size
						</th>
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
								{#if cache.retentionMaxBytes}
									{@const pct = (cache.storageBytes / cache.retentionMaxBytes) * 100}
									<div class="flex flex-col items-end gap-1.5">
										<span>
											{formatBytes(cache.storageBytes)}
											<span class="text-muted-foreground"
												>/ {formatBytes(cache.retentionMaxBytes)}</span
											>
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
									{formatBytes(cache.storageBytes)}
								{/if}
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
			Size is each cache's deduplicated NAR bytes. Chunks shared between NARs, or with other caches,
			count toward every cache that references them, so these sizes can total more than the
			instance's physical storage.
		</p>
	{/if}
</Page>
