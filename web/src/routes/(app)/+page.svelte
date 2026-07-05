<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatBytes, formatCount } from '$lib/format';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Trash2, Check } from '@lucide/svelte';

	let { data, form } = $props();
	const s = $derived(data.stats);
	let running = $state(false);
	let savingLimit = $state(false);

	const tiles = $derived([
		{ label: 'Caches', value: formatCount(s.caches), mono: false },
		{ label: 'Store paths', value: formatCount(s.objects), mono: false },
		{ label: 'NARs stored', value: formatCount(s.nars), mono: false },
		{
			label: data.globalMaxBytes ? 'Storage used / limit' : 'Storage used',
			value: data.globalMaxBytes
				? `${formatBytes(s.storageBytes)} / ${formatBytes(data.globalMaxBytes)}`
				: formatBytes(s.storageBytes),
			mono: true
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
			? (form.gcStats.abandoned_uploads_reaped ?? 0) +
					(form.gcStats.abandoned_caches_reaped ?? 0) +
					(form.gcStats.expired_objects_reaped ?? 0) +
					(form.gcStats.size_evicted_objects ?? 0) +
					(form.gcStats.global_evicted_objects ?? 0) +
					(form.gcStats.orphan_nars_reaped ?? 0) +
					(form.gcStats.orphan_chunks_reaped ?? 0)
			: 0
	);
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Overview</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Content-addressed storage across all caches in this deployment.
		</p>
	</header>

	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		{#each tiles as tile (tile.label)}
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Description>{tile.label}</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="text-3xl font-semibold tracking-tight {tile.mono ? 'font-mono' : ''}">
						{tile.value}
					</div>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<section class="mt-8 rounded-lg border bg-card p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-sm font-medium">Garbage collection</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Runs nightly. Reaps abandoned uploads and soft-deleted caches, retention-expired paths,
					and unreferenced NARs and chunks.
				</p>
			</div>
			<form
				method="POST"
				action="?/gc"
				class="flex items-center gap-2"
				use:enhance={() => {
					running = true;
					return async ({ update }) => {
						await update();
						running = false;
					};
				}}
			>
				<Button type="submit" name="dry_run" value="1" variant="ghost" disabled={running}>
					Preview
				</Button>
				<Button type="submit" variant="outline" disabled={running}>
					<Trash2 class="size-4" />
					{running ? 'Running…' : 'Run now'}
				</Button>
			</form>
		</div>

		<form
			method="POST"
			action="?/saveLimit"
			class="mt-4 flex flex-wrap items-end gap-3 border-t pt-4"
			use:enhance={() => {
				savingLimit = true;
				return async ({ update }) => {
					await update({ reset: false });
					savingLimit = false;
				};
			}}
		>
			<div class="space-y-1">
				<label for="global_max_gib" class="text-xs text-muted-foreground">
					Global storage limit (GiB)
				</label>
				<input
					id="global_max_gib"
					name="global_max_gib"
					type="number"
					step="0.1"
					min="0"
					placeholder="No limit"
					value={globalMaxGib}
					class="flex h-8 w-40 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				/>
			</div>
			<Button type="submit" variant="outline" size="sm" disabled={savingLimit}>
				{savingLimit ? 'Saving…' : 'Save limit'}
			</Button>
			<p class="basis-full text-xs text-muted-foreground">
				Physical (deduplicated) bytes across all caches. When exceeded — checked after every push
				and nightly — least-recently-used closures are evicted from any cache until under the limit;
				pinned closures are never touched.
			</p>
			{#if form?.limitError}
				<p class="text-sm text-destructive">{form.limitError}</p>
			{:else if form?.limitSaved}
				<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
					<Check class="size-4" /> Saved
				</span>
			{/if}
		</form>

		<dl class="mt-4 grid grid-cols-3 gap-4 border-t pt-4 text-sm">
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
			<p class="mt-4 text-sm text-destructive">{form.gcError}</p>
		{:else if form?.gcStats && form?.dryRun}
			<p class="mt-4 text-sm text-muted-foreground">
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
			<p class="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
				<Check class="size-4 text-primary" />
				Reclaimed {formatCount(gcReclaimed)} items ({formatCount(
					form.gcStats.orphan_chunks_reaped ?? 0
				)} chunks freed from storage).
			</p>
		{:else if reclaimable === 0}
			<p class="mt-4 text-sm text-muted-foreground">Nothing to reclaim right now.</p>
		{/if}
	</section>
</div>
