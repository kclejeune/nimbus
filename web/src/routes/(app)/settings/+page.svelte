<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { formatCount, formatRelativeTime, gibInputValue } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Check, Trash2, TriangleAlert } from '@lucide/svelte';

	let { data, form } = $props();
	let running = $state(false);
	let savingLimit = $state(false);

	const reclaimable = $derived(data.pendingNars + data.orphanNars + data.orphanChunks);
	const globalMaxGib = $derived(gibInputValue(data.globalMaxBytes));
	const lastRun = $derived(data.gcLastRun);
	const lastRunReclaimed = $derived(
		lastRun
			? (lastRun.stats.abandoned_caches_reaped ?? 0) +
					(lastRun.stats.detached_objects_reaped ?? 0) +
					(lastRun.stats.expired_objects_reaped ?? 0) +
					(lastRun.stats.size_evicted_objects ?? 0) +
					(lastRun.stats.global_evicted_objects ?? 0)
			: 0
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

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
		<p class="mt-1 text-sm text-muted-foreground">Instance-wide storage policy and maintenance.</p>
	</header>

	<Card.Root>
		<Card.Header>
			<Card.Title>Garbage collection</Card.Title>
			<Card.Description>
				Runs nightly. Reaps abandoned uploads and soft-deleted caches, retention-expired paths, and
				unreferenced NARs and chunks.
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
					Physical (deduplicated) bytes across all caches. When exceeded — checked after every push
					and nightly — least-recently-used closures are evicted from any cache until under the
					limit; pinned closures are never touched.
				</p>
				{#if form?.limitError}
					<p class="text-sm text-destructive">{form.limitError}</p>
				{:else if form?.limitSaved}
					<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
						<Check class="size-4" /> Saved
					</span>
				{/if}
			</form>

			{#if lastRun}
				<div class="flex flex-col gap-2 border-t pt-4 text-sm">
					<p class="text-muted-foreground">
						Last run <span title={lastRun.at}>{formatRelativeTime(lastRun.at)}</span> — removed {formatCount(
							lastRunReclaimed
						)} paths ({formatCount(lastRun.stats.expired_objects_reaped ?? 0)} expired, {formatCount(
							(lastRun.stats.size_evicted_objects ?? 0) +
								(lastRun.stats.global_evicted_objects ?? 0)
						)} over size limits), reclaimed {formatCount(lastRun.stats.orphan_nars_reaped ?? 0)} NARs
						and {formatCount(lastRun.stats.orphan_chunks_reaped ?? 0)} chunks.
					</p>
					{#if lastRun.integrity && lastRun.integrity.incompleteObjects > 0}
						<details class="text-amber-600 dark:text-amber-400">
							<summary class="inline-flex cursor-pointer items-center gap-1.5">
								<TriangleAlert class="size-4" />
								{formatCount(lastRun.integrity.incompleteObjects)}
								{lastRun.integrity.incompleteObjects === 1 ? 'path has' : 'paths have'} references neither
								stored locally nor covered by an upstream — Nix may fail to substitute their closures.
							</summary>
							<ul class="mt-2 space-y-0.5 ps-6 font-mono text-xs">
								{#each lastRun.integrity.examples as example (example)}
									<li>{example}</li>
								{/each}
							</ul>
						</details>
					{/if}
				</div>
			{/if}

			<dl class="grid grid-cols-3 gap-4 border-t pt-4 text-sm">
				<div>
					<dt class="text-xs text-muted-foreground">Pending uploads</dt>
					<dd class="mt-0.5 font-mono">{formatCount(data.pendingNars)}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Orphan NARs</dt>
					<dd class="mt-0.5 font-mono">{formatCount(data.orphanNars)}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Orphan chunks</dt>
					<dd class="mt-0.5 font-mono">{formatCount(data.orphanChunks)}</dd>
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
