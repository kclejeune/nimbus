<script lang="ts">
	import { formatCount } from '$lib/format';
	import StorePathTable from '$lib/components/store-path-table.svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Search } from '@lucide/svelte';

	let { data } = $props();

	const first = $derived((data.page - 1) * data.pageSize + 1);
	const last = $derived(first + data.paths.length - 1);

	// Sentinel for "no cache filter": bits-ui treats '' as no selection, and a
	// '/' can never appear in a cache name so this cannot collide.
	const ALL = '//all';
	const selectedCache = $derived(data.cacheFilter ?? ALL);

	/** Query string for the current filters; page omitted when 1. */
	function href(next: { cache?: string | null; q?: string; page?: number }): string {
		const cache = next.cache !== undefined ? next.cache : data.cacheFilter;
		const q = next.q ?? data.q;
		const page = next.page ?? 1;
		const params = new URLSearchParams();
		if (cache) params.set('cache', cache);
		if (q) params.set('q', q);
		if (page > 1) params.set('page', String(page));
		const qs = params.toString();
		return qs ? `?${qs}` : '?';
	}

	function applyFilters(next: { cache?: string | null; q?: string }) {
		// Any filter change resets to page 1 — the old offset is meaningless.
		goto(href(next), { replaceState: true, keepFocus: true, noScroll: true });
	}

	let debounce: ReturnType<typeof setTimeout>;
	function onSearchInput(e: Event & { currentTarget: HTMLInputElement }) {
		const v = e.currentTarget.value;
		clearTimeout(debounce);
		debounce = setTimeout(() => applyFilters({ q: v }), 300);
	}
</script>

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Paths</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Store paths across every cache you can see, newest first.
		</p>
	</header>

	<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
		<Select.Root
			type="single"
			value={selectedCache}
			onValueChange={(v) => applyFilters({ cache: v === ALL ? null : v })}
		>
			<Select.Trigger size="sm" class="w-44" aria-label="Filter by cache">
				<span data-slot="select-value" class={data.cacheFilter ? 'font-mono text-xs' : ''}>
					{data.cacheFilter ?? 'All caches'}
				</span>
			</Select.Trigger>
			<Select.Content>
				<Select.Item value={ALL}>All caches</Select.Item>
				{#each data.caches as name (name)}
					<Select.Item value={name} class="font-mono text-xs">{name}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<div class="flex items-center gap-3">
			<div class="relative">
				<Search class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					value={data.q}
					oninput={onSearchInput}
					placeholder="Filter by name…"
					class="h-8 w-64 rounded-md border border-input bg-transparent pr-3 pl-8 text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				/>
			</div>
			<span class="text-sm whitespace-nowrap text-muted-foreground">
				{formatCount(data.total)}{data.q ? ' matching' : ' total'}
			</span>
		</div>
	</div>

	{#if data.total === 0 && !data.q}
		<div class="rounded-lg border border-dashed py-16 text-center">
			<p class="text-sm text-muted-foreground">
				No store paths {data.cacheFilter ? 'in this cache' : 'in any visible cache'} yet.
			</p>
		</div>
	{:else}
		{#if data.paths.length === 0}
			<div class="rounded-lg border py-12 text-center">
				<p class="text-sm text-muted-foreground">No paths match “{data.q}”.</p>
			</div>
		{:else}
			<StorePathTable
				showCache
				rows={data.paths.map((p) => ({
					href: `/caches/${encodeURIComponent(p.cache)}/paths/${p.hash}`,
					storePath: p.storePath,
					hash: p.hash,
					createdAt: p.createdAt,
					narSize: p.narSize,
					cache: { name: p.cache, href: `/caches/${encodeURIComponent(p.cache)}` }
				}))}
			/>
		{/if}

		<div class="mt-3 flex flex-wrap items-center justify-between gap-3">
			<p class="text-xs text-muted-foreground">
				{#if data.paths.length > 0}
					Showing {formatCount(first)}–{formatCount(last)} of {formatCount(data.total)}
				{/if}
			</p>
			<div class="flex items-center gap-2">
				{#if data.page > 1}
					<Button variant="outline" size="sm" href={href({ page: data.page - 1 })}>Previous</Button>
				{:else}
					<Button variant="outline" size="sm" disabled>Previous</Button>
				{/if}
				{#if data.hasMore}
					<Button variant="outline" size="sm" href={href({ page: data.page + 1 })}>Next</Button>
				{:else}
					<Button variant="outline" size="sm" disabled>Next</Button>
				{/if}
			</div>
		</div>
	{/if}
</div>
