<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { formatBytes, formatCount } from '$lib/format';
	import IngestChart from '$lib/components/ingest-chart.svelte';
	import UnifiedEndpointCard from '$lib/components/unified-endpoint-card.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Check, Trash2 } from '@lucide/svelte';

	let { data, form } = $props();
	const s = $derived(data.stats);
	let running = $state(false);
	let savingLimit = $state(false);

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
				? `of a ${formatBytes(data.globalMaxBytes)} global limit`
				: 'No global limit set',
			badge: usagePct != null ? `${usagePct}%` : null
		}
	]);

	const reclaimable = $derived(s.pendingNars + s.orphanNars + s.orphanChunks);
	const globalMaxGib = $derived(
		data.globalMaxBytes != null
			? (data.globalMaxBytes / 2 ** 30).toFixed(1).replace(/\.0$/, '')
			: ''
	);
	const gcReclaimed = $derived(
		form?.gcStats
			? (form.gcStats.abandoned_caches_reaped ?? 0) +
					(form.gcStats.expired_objects_reaped ?? 0) +
					(form.gcStats.size_evicted_objects ?? 0) +
					(form.gcStats.global_evicted_objects ?? 0) +
					(form.gcStats.orphan_nars_reaped ?? 0) +
					(form.gcStats.orphan_chunks_reaped ?? 0)
			: 0
	);
</script>

<div class="@container/main flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
	<div
		class="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card"
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
		<div class="px-4 lg:px-6">
			<UnifiedEndpointCard url={data.cacheBaseUrl} publicKey={data.proxyPublicKey} />
		</div>
	{/if}

	<div class="px-4 lg:px-6">
		<IngestChart buckets={data.buckets} />
	</div>

	<div class="px-4 lg:px-6">
		<Card.Root>
			<Card.Header>
				<Card.Title>Garbage collection</Card.Title>
				<Card.Description>
					Runs nightly. Reaps abandoned uploads and soft-deleted caches, retention-expired paths,
					and unreferenced NARs and chunks.
				</Card.Description>
				<Card.Action>
					<form
						method="POST"
						action="?/gc"
						class="flex items-center gap-2"
						use:enhance={toastErrors(() => {
							running = true;
							return async ({ update }) => {
								await update();
								running = false;
							};
						})}
					>
						<Button type="submit" name="dry_run" value="1" variant="ghost" disabled={running}>
							Preview
						</Button>
						<Button type="submit" variant="outline" disabled={running}>
							<Trash2 class="size-4" />
							{running ? 'Running…' : 'Run now'}
						</Button>
					</form>
				</Card.Action>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<form
					method="POST"
					action="?/saveLimit"
					class="flex flex-wrap items-end gap-3 border-t pt-4"
					use:enhance={toastErrors(() => {
						savingLimit = true;
						return async ({ update }) => {
							await update({ reset: false });
							savingLimit = false;
						};
					})}
				>
					<div class="space-y-1">
						<Label for="global_max_gib" class="text-xs text-muted-foreground">
							Global storage limit (GiB)
						</Label>
						<Input
							id="global_max_gib"
							name="global_max_gib"
							type="number"
							step="0.1"
							min="0"
							placeholder="No limit"
							value={globalMaxGib}
							class="w-40"
						/>
					</div>
					<Button type="submit" variant="outline" size="sm" disabled={savingLimit}>
						{savingLimit ? 'Saving…' : 'Save limit'}
					</Button>
					<p class="basis-full text-xs text-muted-foreground">
						Physical (deduplicated) bytes across all caches. When exceeded — checked after every
						push and nightly — least-recently-used closures are evicted from any cache until under
						the limit; pinned closures are never touched.
					</p>
					{#if form?.limitError}
						<p class="text-sm text-destructive">{form.limitError}</p>
					{:else if form?.limitSaved}
						<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
							<Check class="size-4" /> Saved
						</span>
					{/if}
				</form>

				<dl class="grid grid-cols-3 gap-4 border-t pt-4 text-sm">
					<div>
						<dt class="text-xs text-muted-foreground">Pending uploads</dt>
						<dd class="mt-0.5 font-mono">{formatCount(s.pendingNars)}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Orphan NARs</dt>
						<dd class="mt-0.5 font-mono">{formatCount(s.orphanNars)}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Orphan chunks</dt>
						<dd class="mt-0.5 font-mono">{formatCount(s.orphanChunks)}</dd>
					</div>
				</dl>

				{#if form?.gcError}
					<p class="text-sm text-destructive">{form.gcError}</p>
				{:else if form?.gcStats && form?.dryRun}
					<p class="text-sm text-muted-foreground">
						Preview: {formatCount(
							(form.gcStats.expired_objects_reaped ?? 0) +
								(form.gcStats.size_evicted_objects ?? 0) +
								(form.gcStats.global_evicted_objects ?? 0)
						)} paths would be removed by retention ({formatCount(
							form.gcStats.expired_objects_reaped ?? 0
						)} expired, {formatCount(form.gcStats.size_evicted_objects ?? 0)} over cache limits, {formatCount(
							form.gcStats.global_evicted_objects ?? 0
						)} over the global limit). Nothing was deleted.
					</p>
				{:else if form?.gcStats}
					<p class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
						<Check class="size-4 text-primary" />
						Reclaimed {formatCount(gcReclaimed)} items ({formatCount(
							form.gcStats.orphan_chunks_reaped ?? 0
						)} chunks freed from storage).
					</p>
				{:else if reclaimable === 0}
					<p class="text-sm text-muted-foreground">Nothing to reclaim right now.</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
