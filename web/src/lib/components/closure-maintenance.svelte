<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { formatCount, formatRelativeTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import CopyBlock from '$lib/components/copy-block.svelte';
	import StorePath from '$lib/components/layout/store-path.svelte';
	import { Check, RefreshCw, Trash2 } from '@lucide/svelte';
	import type { ClosurePreview } from '$lib/server/cache/closure-maintenance';

	let {
		caches,
		preview = null,
		result = null,
		error = null
	}: {
		caches: { id: number; name: string }[];
		preview?: ClosurePreview | null;
		result?: { removed: number; pending_purge: boolean } | null;
		error?: string | null;
	} = $props();
	let checking = $state(false);
	let removing = $state(false);
	const report = $derived(preview?.inspection);
	const removable = $derived(report?.objects.filter((o) => !o.blocked).length ?? 0);
	const protectedCount = $derived((report?.objects.length ?? 0) - removable);
	const missing = $derived(report?.references.filter((r) => r.status === 'missing').length ?? 0);
	const unverified = $derived(
		report?.references.filter((r) => r.status === 'unverified').length ?? 0
	);
</script>

<section class="mt-5 space-y-4 border-t pt-4" aria-labelledby="closure-maintenance-title">
	<div>
		<h3 id="closure-maintenance-title" class="font-medium">Closure maintenance</h3>
		<p class="mt-1 text-sm text-muted-foreground">
			Recheck dependencies recorded by garbage collection and review which broken paths can be
			removed.
		</p>
	</div>
	{#if caches.length > 0}
		<form
			method="POST"
			action="?/inspectClosures"
			class="flex flex-wrap items-end gap-3"
			use:enhance={toastErrors(() => {
				checking = true;
				return async ({ update }) => {
					try {
						await update({ reset: false });
					} finally {
						checking = false;
					}
				};
			})}
		>
			<div class="min-w-40 space-y-1.5">
				<Label for="closure-cache">Cache</Label>
				<select
					id="closure-cache"
					name="cache"
					class="native-select w-full"
					value={report?.cache.name ?? caches[0].name}
					disabled={checking || removing}
				>
					{#each caches as cache (cache.id)}<option value={cache.name}>{cache.name}</option>{/each}
				</select>
			</div>
			<Button type="submit" variant="outline" size="sm" disabled={checking || removing}>
				<RefreshCw class={checking ? 'animate-spin' : ''} />{checking
					? 'Checking…'
					: 'Check dependencies'}
			</Button>
		</form>
	{:else}
		<p class="text-sm text-muted-foreground">Create a cache before checking dependencies.</p>
	{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	{#if report}
		<div class="space-y-4 rounded-lg border bg-subtle/50 p-4 text-sm" aria-live="polite">
			<div>
				<h4 class="font-medium">
					{report.cache.name}: {formatCount(missing)} missing, {formatCount(unverified)} unverified
				</h4>
				<p class="mt-1 text-muted-foreground">
					Checked {formatCount(report.references.length)}
					{report.references.length === 1 ? 'dependency' : 'dependencies'}
					{formatRelativeTime(report.checkedAt)}. Nothing is removed by checking.
				</p>
			</div>
			{#if report.references.length > 0}
				<div class="max-h-64 overflow-auto rounded-md border">
					<table class="w-full text-left text-xs">
						<thead class="bg-subtle text-muted-foreground"
							><tr
								><th class="px-3 py-2 font-medium">Dependency</th><th class="px-3 py-2 font-medium"
									>Status</th
								><th class="hidden px-3 py-2 text-right font-medium sm:table-cell">Referrers</th
								></tr
							></thead
						>
						<tbody
							>{#each report.references as ref (ref.hash)}<tr class="border-t"
									><td class="max-w-0 px-3 py-2"
										><StorePath path={ref.store_path} wide /><span
											class="mt-1 block text-muted-foreground sm:hidden"
											>{formatCount(ref.referrers)}
											{ref.referrers === 1 ? 'referrer' : 'referrers'}</span
										></td
									><td
										class="px-3 py-2 whitespace-nowrap"
										class:text-warning={ref.status === 'missing'}
										class:text-success={ref.status === 'covered'}
										>{ref.status === 'missing'
											? 'Missing'
											: ref.status === 'covered'
												? 'Covered'
												: 'Unverified'}</td
									><td class="hidden px-3 py-2 text-right tabular-nums sm:table-cell"
										>{formatCount(ref.referrers)}</td
									></tr
								>{/each}</tbody
						>
					</table>
				</div>
			{:else}
				<p class="inline-flex items-center gap-1.5 text-muted-foreground">
					<Check class="size-4 text-success" />{report.after
						? 'No more unresolved dependencies found after this batch.'
						: 'No unresolved dependencies found in the recorded graph.'}
				</p>
			{/if}
			{#if missing > 0 || unverified > 0}
				<div class="space-y-2">
					<h4 class="font-medium">Repair from a build machine</h4>
					<p class="text-muted-foreground">
						The browser cannot read a machine’s local Nix store. Run this on a machine that built
						these paths to upload the dependencies it still has. Replace <code>SERVER</code> with this
						instance’s CLI server name.
					</p>
					<CopyBlock
						text={`nimbus repair SERVER:${report.cache.name} --apply`}
						label="Copy repair command"
					/>
					{#if unverified > 0}<p class="text-muted-foreground">
							Unverified dependencies could not be checked upstream. They are excluded from removal.
						</p>{/if}
				</div>
			{/if}
			{#if report.objects.length > 0}
				<div class="space-y-2">
					<h4 class="font-medium">Removal preview</h4>
					<p class="text-muted-foreground">
						{formatCount(removable)}
						{removable === 1 ? 'path' : 'paths'} can be removed; {formatCount(protectedCount)}
						{protectedCount === 1 ? 'path is' : 'paths are'} protected by pins, recent uploads or retained
						closures. Shared NARs and chunks are reclaimed by GC.
					</p>
					<details class="rounded-md border px-3 py-2" open>
						<summary class="cursor-pointer font-medium">Review affected paths</summary>
						<ul class="mt-2 max-h-64 space-y-2 overflow-auto">
							{#each report.objects as object (object.id)}<li
									class="flex items-baseline justify-between gap-3"
								>
									<StorePath path={object.store_path} wide /><span
										class="shrink-0 text-xs"
										class:text-destructive={!object.blocked}
										class:text-muted-foreground={!!object.blocked}
										>{object.blocked ? 'Protected' : 'Remove'}</span
									>
								</li>{/each}
						</ul>
					</details>
					{#if report.truncated}
						<p class="text-warning">
							This preview is incomplete. Review the full plan with <code
								>nimbus purge SERVER:{report.cache.name}</code
							>
							before applying it with <code>--apply</code>.
						</p>
					{:else if result}
						<p role="status" class="text-muted-foreground">
							Removed {formatCount(result.removed)} paths. {formatCount(
								Math.max(0, removable - result.removed)
							)} reviewed paths were retained because their state or protection changed.{#if result.pending_purge}
								Edge invalidation is queued and will continue automatically.{/if}
						</p>
					{:else if removable > 0 && preview}
						<form
							method="POST"
							action="?/purgeClosures"
							use:enhance={toastErrors(
								confirmFirst(
									() => ({
										title: `Remove ${formatCount(removable)} broken paths from ${report.cache.name}?`,
										description:
											'Only the reviewed paths still missing dependencies will be removed. Pins and recent uploads remain protected.',
										confirmLabel: 'Remove broken paths',
										tone: 'danger',
										typeToConfirm: report.cache.name
									}),
									() => {
										removing = true;
										return async ({ update }) => {
											try {
												await update({ reset: false });
											} finally {
												removing = false;
											}
										};
									}
								)
							)}
						>
							<input type="hidden" name="preview" value={preview.token} />
							<Button type="submit" variant="destructive" size="sm" disabled={checking || removing}
								><Trash2 />{removing
									? 'Removing…'
									: `Remove ${formatCount(removable)} broken paths`}</Button
							>
						</form>
					{/if}
				</div>
			{:else if missing > 0}
				<p class="text-muted-foreground">
					No unprotected paths can be removed for these dependencies.
				</p>
			{/if}
			{#if report.nextCursor}
				<form
					method="POST"
					action="?/inspectClosures"
					use:enhance={toastErrors(() => {
						checking = true;
						return async ({ update }) => {
							try {
								await update({ reset: false });
							} finally {
								checking = false;
							}
						};
					})}
				>
					<input type="hidden" name="cache" value={report.cache.name} /><input
						type="hidden"
						name="after"
						value={report.nextCursor}
					/>
					<Button type="submit" variant="outline" size="sm" disabled={checking || removing}
						>Check next dependencies</Button
					>
				</form>
			{/if}
			<p class="text-xs text-muted-foreground">
				The warning from the last GC is historical. It refreshes after the next GC run.
			</p>
		</div>
	{/if}
</section>
