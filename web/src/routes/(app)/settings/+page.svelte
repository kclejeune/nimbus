<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { GcOperation } from '$lib/server/cache/gc';
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
	import ClosureMaintenance from '$lib/components/closure-maintenance.svelte';

	let { data, form } = $props();
	let running = $state(false);
	let savingLimit = $state(false);

	let operation = $state<GcOperation | null>(untrack(() => data.gcOperation));
	let latestRun = $state<typeof data.gcLastRun>(null);
	let purge = $state<{ id: string; removed: number; pending_purge: boolean } | null>(null);
	let progressError = $state('');
	const preview = $derived(form?.closurePreview ?? data.maintenance?.preview ?? null);
	const result = $derived(
		purge && purge.id === preview?.inspection.operationId
			? purge
			: (form?.closurePurge ??
					(data.maintenance?.preview.inspection.operationId === preview?.inspection.operationId
						? data.maintenance?.purge
						: null) ??
					null)
	);
	$effect(() => {
		const incoming = form?.gcOperation ?? data.gcOperation;
		untrack(() => {
			if (
				incoming &&
				(!operation ||
					incoming.id > operation.id ||
					(incoming.id === operation.id && operation.state !== 'complete'))
			)
				operation = incoming;
		});
	});
	$effect(() => {
		const run = data.gcLastRun;
		untrack(() => {
			if (run && (!latestRun || run.at > latestRun.at)) latestRun = run;
		});
	});
	onMount(() => {
		let stopped = false;
		async function poll() {
			while (!stopped) {
				await new Promise((r) => setTimeout(r, 5000));
				if (stopped) break;
				if (operation?.state !== 'pending' && !result?.pending_purge) continue;
				try {
					const id = preview?.inspection.operationId;
					const response = await fetch(
						'/settings/status' +
							(result?.pending_purge && id ? '?operation=' + encodeURIComponent(id) : '')
					);
					if (!response.ok) throw new Error();
					const status = await response.json();
					if (stopped) break;
					if (status.gcOperation) operation = status.gcOperation;
					if (status.gcLastRun) latestRun = status.gcLastRun;
					if (status.closurePurge) purge = status.closurePurge;
					progressError = '';
				} catch {
					progressError =
						'Status is temporarily unavailable. Work and progress are saved; retrying automatically.';
				}
			}
		}
		void poll();
		return () => {
			stopped = true;
		};
	});
	const globalMaxGib = $derived(gibInputValue(data.globalMaxBytes));
	const lastRun = $derived(latestRun ?? data.gcLastRun);
	const lastRunReclaimed = $derived(
		lastRun
			? (lastRun.stats.abandoned_caches_reaped ?? 0) +
					(lastRun.stats.detached_objects_reaped ?? 0) +
					(lastRun.stats.expired_objects_reaped ?? 0) +
					(lastRun.stats.size_evicted_objects ?? 0) +
					(lastRun.stats.global_evicted_objects ?? 0) +
					(lastRun.stats.automatic_objects_removed ?? 0)
			: 0
	);
</script>

<Page>
	<PageHeader title="Settings" description="Instance-wide storage policy and maintenance." />

	{#if data.dataUnavailable}<p
			role="status"
			class="mb-4 rounded-lg border border-warning/30 p-3 text-sm text-warning"
		>
			Some details could not be refreshed. Recent values are shown where available; other details
			are unavailable. Retry this page shortly. Maintenance progress is saved.
		</p>{/if}
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
				description="Physical bytes after dedup, across all caches. Over the limit, the least recently used closures are evicted from any cache. Pinned closures are never evicted."
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
						disabled={data.limitUnavailable}
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
					<Button type="submit" size="sm" disabled={savingLimit || data.limitUnavailable}>
						{savingLimit ? 'Saving…' : 'Save limit'}
					</Button>
				{/snippet}
			</Panel>
		</form>

		<Panel
			title="Garbage collection"
			description="Applies to all caches, independently of the dependency-check selection below. Runs nightly in paced batches and continues automatically after this page closes."
		>
			{#snippet actions()}
				<form
					method="POST"
					action="?/gc"
					class="flex items-center gap-2"
					use:enhance={toastErrors(() => {
						running = true;
						return async ({ update }) => {
							await update({ invalidateAll: false });
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
						disabled={running || operation?.state === 'pending'}
					>
						Preview all caches
					</Button>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={running || operation?.state === 'pending'}
					>
						<Trash2 />
						{running ? 'Queuing…' : 'Collect all caches'}
					</Button>
				</form>
			{/snippet}

			{#if form?.gcError}<p role="alert" class="mt-4 text-sm text-destructive">
					{form.gcError}
				</p>{/if}
			{#if progressError}<p role="status" class="mt-4 text-sm text-warning">{progressError}</p>{/if}
			{#if operation}
				<div class="mt-4 space-y-2 rounded-lg border p-4 text-sm" aria-live="polite">
					<p class="font-medium">
						{operation.dryRun ? 'GC preview' : 'Garbage collection'} · All caches · {operation.state ===
						'complete'
							? 'Complete'
							: 'In progress'}
					</p>
					<p class="text-muted-foreground">
						Requested {formatRelativeTime(operation.requestedAt)}. {#if operation.state === 'pending'}{operation.phase}.
							Work resumes automatically between paced batches; refreshing does not restart it.{:else if operation.dryRun}Preview
							complete: {formatCount(
								(operation.stats.expired_objects_reaped ?? 0) +
									(operation.stats.size_evicted_objects ?? 0) +
									(operation.stats.global_evicted_objects ?? 0)
							)} paths would be removed by retention. Nothing was deleted. Broken-closure discovery is
							checked separately below.{:else}Finished {formatRelativeTime(operation.completedAt!)}.
							Results are saved below.{/if}
					</p>
				</div>
			{/if}

			<ClosureMaintenance
				caches={data.closureCaches}
				check={form?.closureCheck ?? data.closureCheck}
				allowAll
				{preview}
				{result}
				previewExpired={!!data.maintenance?.expired &&
					preview?.token === data.maintenance.preview.token}
				error={form?.maintenanceError ??
					(preview?.token === data.maintenance?.preview.token ? data.maintenance?.message : null) ??
					null}
			/>

			{#if lastRun}
				<div class="mt-5 space-y-3 border-t pt-4 text-sm">
					<p class="text-muted-foreground">
						Last completed across all caches <span class="text-foreground" title={lastRun.at}
							>{formatRelativeTime(lastRun.at)}</span
						>: removed {formatCount(lastRunReclaimed)} paths ({formatCount(
							lastRun.stats.expired_objects_reaped ?? 0
						)} expired, {formatCount(
							(lastRun.stats.size_evicted_objects ?? 0) +
								(lastRun.stats.global_evicted_objects ?? 0)
						)} over size limits) and reclaimed {formatCount(lastRun.stats.orphan_nars_reaped ?? 0)} NARs
						and {formatCount(lastRun.stats.orphan_chunks_reaped ?? 0)} chunks.
					</p>
					{#if lastRun.stats.automatic_refs_checked > 0 || lastRun.stats.automatic_purge_errors > 0}
						<p class="text-muted-foreground">
							Automatic broken-closure cleanup checked {formatCount(
								lastRun.stats.automatic_refs_checked ?? 0
							)} dependencies and removed {formatCount(
								lastRun.stats.automatic_objects_removed ?? 0
							)} paths. {formatCount(lastRun.stats.automatic_refs_waiting ?? 0)} confirmed missing dependencies
							are waiting for the policy delay; {formatCount(
								lastRun.stats.automatic_purge_deferred ?? 0
							)} groups were deferred by maintenance limits and {formatCount(
								lastRun.stats.automatic_purge_errors ?? 0
							)} errors occurred.
						</p>
					{/if}
					{#if lastRun.stats.advisory_phases_deferred > 0}
						<p class="mt-2 text-warning">
							Some advisory closure maintenance was deferred after repeated D1 resource failures.
							Later maintenance completed; deferred work will retry on the next GC run.
						</p>
					{/if}
					{#if lastRun.integrity?.deferred}
						<p class="mt-2 text-warning">
							The closure warning below is retained from the previous successful integrity check.
						</p>
					{/if}
					{#if lastRun.integrity && lastRun.integrity.incompleteObjects > 0}
						<details
							class="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5 text-warning"
						>
							<summary class="flex cursor-pointer items-start gap-1.5">
								<TriangleAlert class="mt-0.5 size-4 shrink-0" />
								<span>
									{formatCount(lastRun.integrity.incompleteObjects)}
									{lastRun.integrity.incompleteObjects === 1 ? 'path has' : 'paths have'} references that
									weren’t confirmed in their cache or upstreams at the last GC, so Nix may fail to substitute
									their closures.
								</span>
							</summary>
							<ul class="mt-2 space-y-1 ps-6 text-foreground">
								{#each lastRun.integrity.examples as example (example)}
									<li><StorePath path={example} full /></li>
								{/each}
							</ul>
							<p class="mt-2 ps-6 text-sm text-foreground">
								Use Closure maintenance above to recheck coverage, repair from a build machine, or
								preview removal of broken paths. This list refreshes after the next GC run.
							</p>
						</details>
					{/if}
				</div>
			{/if}
		</Panel>
	</div>
</Page>
