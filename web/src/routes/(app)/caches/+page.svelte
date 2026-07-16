<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Plus, Lock, Globe } from '@lucide/svelte';

	let { data } = $props();
</script>

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
	<header class="mb-8 flex items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">Caches</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Each cache is an isolated view into the shared content-addressed store.
			</p>
		</div>
		<Button href="/caches/new">
			<Plus class="size-4" />
			New cache
		</Button>
	</header>

	{#if data.caches.length === 0}
		<div class="rounded-lg border border-dashed py-16 text-center">
			<p class="text-sm text-muted-foreground">No caches yet.</p>
		</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border">
			<table class="w-full text-sm">
				<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
					<tr>
						<th class="px-4 py-2.5 font-medium">Name</th>
						<th class="px-4 py-2.5 font-medium">Visibility</th>
						<th class="px-4 py-2.5 text-right font-medium">Paths</th>
						<th
							class="px-4 py-2.5 text-right font-medium"
							title="NAR bytes attributed to this cache; content shared with other NARs or caches counts in each"
						>
							Size
						</th>
						<th class="px-4 py-2.5 font-medium">Compression</th>
						<th class="px-4 py-2.5 text-right font-medium">Priority</th>
						<th class="px-4 py-2.5 font-medium">Retention</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each data.caches as cache (cache.name)}
						<tr class="transition-colors hover:bg-muted/30">
							<td class="px-4 py-3">
								<a href="/caches/{cache.name}" class="font-mono font-medium hover:text-primary">
									{cache.name}
								</a>
							</td>
							<td class="px-4 py-3">
								{#if cache.isPublic}
									<span class="inline-flex items-center gap-1.5 text-muted-foreground">
										<Globe class="size-3.5" /> Public
									</span>
								{:else}
									<span class="inline-flex items-center gap-1.5 text-muted-foreground">
										<Lock class="size-3.5" /> Private
									</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-right font-mono">{formatCount(cache.objects)}</td>
							<td class="px-4 py-3 text-right">
								{#if cache.retentionMaxBytes}
									{@const pct = (cache.storageBytes / cache.retentionMaxBytes) * 100}
									<div class="flex flex-col items-end gap-1">
										<span class="font-mono text-xs">
											{formatBytes(cache.storageBytes)} of {formatBytes(cache.retentionMaxBytes)}
										</span>
										<div
											class="h-1 w-24 overflow-hidden rounded-full bg-muted"
											title="{Math.round(pct)}% of size budget"
										>
											<div
												class="h-full rounded-full {pct >= 90 ? 'bg-amber-500' : 'bg-primary'}"
												style="width: {Math.min(100, pct)}%"
											></div>
										</div>
									</div>
								{:else}
									<span class="font-mono">{formatBytes(cache.storageBytes)}</span>
								{/if}
							</td>
							<td class="px-4 py-3 font-mono text-muted-foreground">{cache.compression}</td>
							<td class="px-4 py-3 text-right font-mono">{cache.priority}</td>
							<td class="px-4 py-3 text-muted-foreground">
								{cache.retentionDays ? `${cache.retentionDays}d` : '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="mt-2 text-xs text-muted-foreground">
			Size is each cache's deduplicated NAR bytes. Chunks shared between NARs — or with other caches
			— count toward every cache that references them, so these sizes can total more than the
			instance's physical storage.
		</p>
	{/if}
</div>
