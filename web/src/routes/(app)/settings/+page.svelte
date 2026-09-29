<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { formatCount, formatRelativeTime, gibInputValue } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Check, Trash2, TriangleAlert } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StorePath from '$lib/components/layout/store-path.svelte';

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

<Page width="narrow">
	<PageHeader title="Settings" description="Instance-wide storage policy and maintenance." />

	<div class="grid grid-cols-1 gap-6">
		<form
			method="POST"
			action="?/saveLimit"
			use:enhance={toastErrors(() => {
				savingLimit = true;
				return async ({ update }) => {
					await update({ reset: false });
					savingLimit = false;
				};
			})}
		>
			<Panel
				title="Storage limit"
				description="Physical, deduplicated bytes across all caches. When the limit is exceeded, checked after every push and nightly, the least-recently-used closures are evicted from any cache until storage is back under it. Pinned closures are never evicted."
			>
				<div class="space-y-2">
					<Label for="global_max_gib">Global limit (GiB)</Label>
					<Input
						id="global_max_gib"
						name="global_max_gib"
						type="number"
						step="0.1"
						min="0"
						placeholder="No limit"
						value={globalMaxGib}
						class="w-48"
					/>
				</div>
				{#snippet footer()}
					<span>
						{#if form?.limitError}
							<span role="alert" class="text-destructive">{form.limitError}</span>
						{:else if form?.limitSaved}
							<span class="inline-flex items-center gap-1.5">
								<Check class="size-4 text-success" /> Limit saved
							</span>
						{:else}
							Leave blank for no limit.
						{/if}
					</span>
					<Button type="submit" size="sm" disabled={savingLimit}>
						{savingLimit ? 'Saving…' : 'Save limit'}
					</Button>
				{/snippet}
			</Panel>
		</form>

		<Panel
			title="Garbage collection"
			description="Runs nightly. Reaps abandoned uploads and deleted caches, retention-expired paths, and NARs and chunks nothing references."
		>
			{#snippet actions()}
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
					<Button
						type="submit"
						name="dry_run"
						value="1"
						variant="ghost"
						size="sm"
						disabled={running}
					>
						Preview
					</Button>
					<Button type="submit" variant="outline" size="sm" disabled={running}>
						<Trash2 />
						{running ? 'Running…' : 'Run now'}
					</Button>
				</form>
			{/snippet}

			<dl class="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border text-sm">
				<div class="bg-subtle px-4 py-3">
					<dt class="text-xs text-muted-foreground">Pending uploads</dt>
					<dd class="mt-1 text-lg font-semibold tabular-nums">{formatCount(data.pendingNars)}</dd>
				</div>
				<div class="bg-subtle px-4 py-3">
					<dt class="text-xs text-muted-foreground">Orphan NARs</dt>
					<dd class="mt-1 text-lg font-semibold tabular-nums">{formatCount(data.orphanNars)}</dd>
				</div>
				<div class="bg-subtle px-4 py-3">
					<dt class="text-xs text-muted-foreground">Orphan chunks</dt>
					<dd class="mt-1 text-lg font-semibold tabular-nums">{formatCount(data.orphanChunks)}</dd>
				</div>
			</dl>

			{#if form?.gcError}
				<p role="alert" class="mt-4 text-sm text-destructive">{form.gcError}</p>
			{:else if form?.gcStats && form?.dryRun}
				<p class="mt-4 rounded-lg border bg-subtle px-3 py-2.5 text-sm text-muted-foreground">
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
					<Check class="size-4 text-success" />
					Reclaimed {formatCount(gcReclaimed)} items ({formatCount(
						form.gcStats.orphan_chunks_reaped ?? 0
					)} chunks freed from storage).
				</p>
			{:else if reclaimable === 0}
				<p class="mt-4 text-sm text-muted-foreground">Nothing to reclaim right now.</p>
			{/if}

			{#if lastRun}
				<div class="mt-5 space-y-3 border-t pt-4 text-sm">
					<p class="text-muted-foreground">
						Last ran <span class="text-foreground" title={lastRun.at}
							>{formatRelativeTime(lastRun.at)}</span
						>: removed {formatCount(lastRunReclaimed)} paths ({formatCount(
							lastRun.stats.expired_objects_reaped ?? 0
						)} expired, {formatCount(
							(lastRun.stats.size_evicted_objects ?? 0) +
								(lastRun.stats.global_evicted_objects ?? 0)
						)} over size limits) and reclaimed {formatCount(lastRun.stats.orphan_nars_reaped ?? 0)} NARs
						and {formatCount(lastRun.stats.orphan_chunks_reaped ?? 0)} chunks.
					</p>
					{#if lastRun.integrity && lastRun.integrity.incompleteObjects > 0}
						<details
							class="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5 text-warning"
						>
							<summary class="flex cursor-pointer items-start gap-1.5">
								<TriangleAlert class="mt-0.5 size-4 shrink-0" />
								<span>
									{formatCount(lastRun.integrity.incompleteObjects)}
									{lastRun.integrity.incompleteObjects === 1 ? 'path has' : 'paths have'} references that
									are neither stored locally nor covered by an upstream, so Nix may fail to substitute
									their closures.
								</span>
							</summary>
							<ul class="mt-2 space-y-1 ps-6 text-foreground">
								{#each lastRun.integrity.examples as example (example)}
									<li><StorePath path={example} /></li>
								{/each}
							</ul>
						</details>
					{/if}
				</div>
			{/if}
		</Panel>
	</div>
</Page>
