<script lang="ts">
	import { formatBytes, formatCount } from '$lib/format';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import StorePath from '$lib/components/layout/store-path.svelte';
	import SearchInput from '$lib/components/layout/search-input.svelte';
	import {
		FolderSearch,
		ArrowUp,
		ArrowDown,
		LoaderCircle,
		Pin,
		PinOff,
		Scissors,
		X
	} from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { ask } from '$lib/confirm.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	type SortKey = 'name' | 'date' | 'size';

	let { data, form } = $props();
	const c = $derived(data.cache);
	const pinnedSet = $derived(new Set(data.pinnedHashes));

	function shortHash(path: string): string {
		// Trim the /nix/store/<hash>- prefix for readability; keep the human name.
		return path.replace(/^\/nix\/store\//, '');
	}

	// RFC3339 timestamp → YYYY-MM-DD.
	const fmtDate = (s: string) => (s ? s.slice(0, 10) : '');

	// --- Store paths: sort + name search (URL-driven) + infinite scroll ---
	// `data.paths` is the server's first page; scroll fetches accumulate in `extra`.
	let extra = $state<typeof data.paths>([]);
	let extraHasMore = $state(false);
	let appended = $state(false);
	let loading = $state(false);

	const rows = $derived(appended ? [...data.paths, ...extra] : data.paths);
	const hasMore = $derived(appended ? extraHasMore : data.hasMore);
	const queryKey = $derived(`${data.sort}\u0000${data.dir}\u0000${data.q}`);

	// Any change to sort/dir/search reloads the first page — drop accumulated
	// rows, and the selection with them (it may name rows no longer shown).
	$effect(() => {
		queryKey;
		extra = [];
		appended = false;
		// untrack: clear() may read the set's size, which would make every
		// checkbox toggle re-run this effect and wipe the selection.
		untrack(() => selected.clear());
	});

	// --- Bulk selection: only offered when there's a bulk action to take. ---
	const canSelect = $derived(data.viewer.canRetention || data.viewer.canDelete);
	const selected = new SvelteSet<string>();
	const allSelected = $derived(rows.length > 0 && rows.every((r) => selected.has(r.hash)));
	const someSelected = $derived(selected.size > 0 && !allSelected);
	const overCap = $derived(selected.size > data.bulkMax);
	const selectedPinned = $derived([...selected].filter((h) => pinnedSet.has(h)).length);
	let bulkBusy = $state(false);

	function toggleAll() {
		if (allSelected) selected.clear();
		else for (const r of rows) selected.add(r.hash);
	}
	function toggle(hash: string) {
		if (selected.has(hash)) selected.delete(hash);
		else selected.add(hash);
	}

	// The bar's buttons share one form and pick their action via formaction;
	// only removal asks first.
	const bulkSubmit: SubmitFunction = async ({ action, cancel }) => {
		const kind = action.search.includes('pruneMany')
			? 'prune'
			: action.search.includes('unpinMany')
				? 'unpin'
				: 'pin';
		const n = selected.size;
		if (kind === 'prune') {
			const ok = await ask({
				title: `Remove ${n} ${n === 1 ? 'path' : 'paths'}?`,
				description:
					'They stop being served from this cache now. Anything another path still depends on is kept until its last dependent goes, and garbage collection reclaims the storage.',
				confirmLabel: `Remove ${n} ${n === 1 ? 'path' : 'paths'}`,
				tone: 'danger'
			});
			if (!ok) {
				cancel();
				return;
			}
		}
		bulkBusy = true;
		return async ({ result, update }) => {
			await update();
			bulkBusy = false;
			if (result.type !== 'success') return;
			selected.clear();
			if (kind === 'prune') {
				extra = [];
				appended = false;
			} else {
				toast.success(
					`${kind === 'pin' ? 'Pinned' : 'Unpinned'} ${n} ${n === 1 ? 'path' : 'paths'}`
				);
			}
		};
	};

	function applyParams(next: { sort?: SortKey; dir?: string; q?: string }) {
		const sort = next.sort ?? data.sort;
		const dir = next.dir ?? data.dir;
		const q = next.q ?? data.q;
		const params = new URLSearchParams();
		if (sort !== 'date') params.set('sort', sort);
		if (dir !== 'desc') params.set('dir', dir);
		if (q) params.set('q', q);
		const qs = params.toString();
		goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
	}

	let debounce: ReturnType<typeof setTimeout>;
	function onSearchInput(e: Event & { currentTarget: HTMLInputElement }) {
		const v = e.currentTarget.value;
		clearTimeout(debounce);
		debounce = setTimeout(() => applyParams({ q: v }), 300);
	}

	function toggleSort(key: SortKey) {
		// Same column flips direction; a new column defaults to descending, except
		// name which reads better ascending (A→Z).
		if (data.sort === key) applyParams({ dir: data.dir === 'asc' ? 'desc' : 'asc' });
		else applyParams({ sort: key, dir: key === 'name' ? 'asc' : 'desc' });
	}

	async function loadMore() {
		if (loading || !hasMore) return;
		loading = true;
		try {
			const params = new URLSearchParams({
				sort: data.sort,
				dir: data.dir,
				offset: String(rows.length)
			});
			if (data.q) params.set('q', data.q);
			const res = await fetch(`/caches/${encodeURIComponent(c.name)}/paths?${params}`);
			if (res.ok) {
				const more = (await res.json()) as { paths: typeof data.paths; hasMore: boolean };
				extra = [...extra, ...more.paths];
				extraHasMore = more.hasMore;
				appended = true;
			}
		} finally {
			loading = false;
		}
	}

	let scrollBox = $state<HTMLElement>();
	let sentinel = $state<HTMLElement>();

	// Clamp the list to the space left on screen below the table so it scrolls
	// internally instead of growing the page. Set from JS (not a CSS class) so a
	// stale cached stylesheet can't defeat it. Fills to ~near the viewport bottom
	// (leaving room for the "Showing X of Y" line); a clamped box means the
	// infinite scroll self-limits, so no cap is needed.
	let maxH = $state(560);
	$effect(() => {
		if (!scrollBox) return;
		const measure = () => {
			const top = scrollBox!.getBoundingClientRect().top;
			maxH = Math.max(360, Math.round(window.innerHeight - top - 44));
		};
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});

	$effect(() => {
		if (!sentinel || !scrollBox) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) loadMore();
			},
			{ root: scrollBox, rootMargin: '150px' }
		);
		io.observe(sentinel);
		return () => io.disconnect();
	});
</script>

{#snippet sortHeader(key: SortKey, label: string)}
	<button
		type="button"
		onclick={() => toggleSort(key)}
		class="inline-flex items-center gap-1 font-medium transition-colors hover:text-foreground {data.sort ===
		key
			? 'text-foreground'
			: ''}"
	>
		{label}
		{#if data.sort === key}
			{#if data.dir === 'asc'}<ArrowUp class="size-3" />{:else}<ArrowDown class="size-3" />{/if}
		{/if}
	</button>
{/snippet}

<div>
	<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm text-muted-foreground tabular-nums">
			{formatCount(data.total)}{data.q ? ' matching' : ' store paths'}
		</p>
		<SearchInput value={data.q} oninput={onSearchInput} aria-label="Filter store paths by name" />
	</div>

	{#if form && 'pruned' in form}
		<p class="mb-3 text-sm text-muted-foreground">
			Removed {formatCount(form.pruned ?? 0)}
			{form.pruned === 1 ? 'path' : 'paths'}. Anything still referenced by another path is kept
			until its last dependent goes; freed storage is reclaimed by the next garbage collection.
		</p>
	{:else if form?.actionError}
		<p class="mb-3 text-sm text-destructive">{form.actionError}</p>
	{/if}

	{#if data.total === 0 && !data.q}
		<EmptyState
			icon={FolderSearch}
			title="Nothing pushed yet"
			description="Push a store path with the nimbus CLI and it appears here."
		/>
	{:else}
		<div bind:this={scrollBox} style="max-height: {maxH}px" class="table-frame overflow-y-auto">
			<table class="data-table">
				<thead class="sticky top-0 z-10">
					<tr>
						{#if canSelect}
							<th class="w-10 !pr-0">
								<input
									type="checkbox"
									aria-label="Select all loaded paths"
									checked={allSelected}
									indeterminate={someSelected}
									onchange={toggleAll}
									class="size-4 rounded border-input text-primary focus:ring-ring"
								/>
							</th>
						{/if}
						<th>{@render sortHeader('name', 'Store path')}</th>
						<th class="w-32">{@render sortHeader('date', 'Added')}</th>
						<th class="num w-28">{@render sortHeader('size', 'NAR size')}</th>
						<th class="w-20 !px-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as p (p.hash)}
						{@const isPinned = pinnedSet.has(p.hash)}
						<tr class="group {selected.has(p.hash) ? 'bg-accent/40' : ''}">
							{#if canSelect}
								<td class="w-10 !pr-0">
									<input
										type="checkbox"
										aria-label="Select {shortHash(p.storePath)}"
										checked={selected.has(p.hash)}
										onchange={() => toggle(p.hash)}
										class="size-4 rounded border-input text-primary focus:ring-ring"
									/>
								</td>
							{/if}
							<td class="w-full max-w-0">
								<div class="flex min-w-0 items-center gap-2">
									<StorePath
										path={p.storePath}
										href="/caches/{encodeURIComponent(c.name)}/paths/{p.hash}"
										wide
									/>
									{#if isPinned}
										<StatusBadge tone="primary" title="Pinned: protected from garbage collection">
											Pinned
										</StatusBadge>
									{/if}
								</div>
							</td>
							<td class="font-mono text-[0.8125rem] whitespace-nowrap text-muted-foreground"
								>{fmtDate(p.createdAt)}</td
							>
							<td class="num">{formatBytes(p.narSize)}</td>
							<td class="!px-2 !py-1">
								<div
									class="flex items-center justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
								>
									{#if data.viewer.canRetention}
										<form
											method="POST"
											action={isPinned ? '?/unpin' : '?/pin'}
											use:enhance={toastErrors()}
										>
											<input type="hidden" name="hash" value={p.hash} />
											<button
												type="submit"
												title={isPinned
													? 'Unpin: allow garbage collection again'
													: 'Pin: protect this path and its closure from garbage collection'}
												aria-label={isPinned ? 'Unpin' : 'Pin'}
												class="rounded-md p-1.5 transition-colors hover:bg-muted {isPinned
													? 'text-primary'
													: 'text-muted-foreground hover:text-foreground'}"
											>
												<Pin class="size-3.5 {isPinned ? 'fill-current' : ''}" />
											</button>
										</form>
									{/if}
									{#if data.viewer.canDelete}
										<form
											method="POST"
											action="?/prune"
											use:enhance={toastErrors(
												confirmFirst(
													{
														title: `Remove ${shortHash(p.storePath).replace(/^[0-9a-z]{32}-/, '')}?`,
														description:
															'It stops being served from this cache now. Anything another path still depends on is kept until its last dependent goes, and garbage collection reclaims the storage.',
														confirmLabel: 'Remove path',
														tone: 'danger'
													},
													() =>
														async ({ update }) => {
															await update();
															extra = [];
															appended = false;
														}
												)
											)}
										>
											<input type="hidden" name="hash" value={p.hash} />
											<button
												type="submit"
												title="Remove this path (closure-safe: shared dependencies stay while needed)"
												aria-label="Remove path"
												class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
											>
												<Scissors class="size-3.5" />
											</button>
										</form>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>

			{#if rows.length === 0}
				<p class="py-12 text-center text-sm text-muted-foreground">
					No paths match “{data.q}”.
				</p>
			{/if}

			<div bind:this={sentinel} aria-hidden="true"></div>
			{#if loading}
				<div
					class="flex items-center justify-center gap-2 border-t py-3 text-xs text-muted-foreground"
				>
					<LoaderCircle class="size-3.5 animate-spin" /> Loading more
				</div>
			{:else if !hasMore && rows.length > 0}
				<div class="border-t py-3 text-center text-xs text-muted-foreground">End of list</div>
			{/if}
		</div>

		<p class="mt-2 text-xs text-muted-foreground tabular-nums">
			Showing {formatCount(rows.length)} of {formatCount(data.total)}
		</p>
	{/if}
	{#if selected.size > 0}
		<!-- Floats over the list while rows are selected; only permitted actions. -->
		<div class="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
			<form
				method="POST"
				use:enhance={toastErrors(bulkSubmit)}
				class="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border bg-popover py-2 pr-2 pl-4 text-sm shadow-(--shadow-sheet)"
			>
				{#each [...selected] as hash (hash)}
					<input type="hidden" name="hash" value={hash} />
				{/each}
				<span class="font-medium tabular-nums">{selected.size} selected</span>
				{#if overCap}
					<span class="text-xs text-warning">Select at most {data.bulkMax} at a time</span>
				{/if}
				<span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
				{#if data.viewer.canRetention}
					{#if selectedPinned < selected.size}
						<Button
							type="submit"
							variant="ghost"
							size="sm"
							formaction="?/pinMany"
							disabled={bulkBusy || overCap}><Pin /> Pin</Button
						>
					{/if}
					{#if selectedPinned > 0}
						<Button
							type="submit"
							variant="ghost"
							size="sm"
							formaction="?/unpinMany"
							disabled={bulkBusy || overCap}><PinOff /> Unpin</Button
						>
					{/if}
				{/if}
				{#if data.viewer.canDelete}
					<Button
						type="submit"
						variant="ghost"
						size="sm"
						formaction="?/pruneMany"
						disabled={bulkBusy || overCap}
						class="text-destructive hover:bg-destructive/10 hover:text-destructive"
						><Scissors /> Remove</Button
					>
				{/if}
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label="Clear selection"
					onclick={() => selected.clear()}><X /></Button
				>
			</form>
		</div>
	{/if}
</div>
