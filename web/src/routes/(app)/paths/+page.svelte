<script lang="ts">
	import { formatCount } from '$lib/format';
	import StorePathTable from '$lib/components/store-path-table.svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { FolderSearch, Search } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import SearchInput from '$lib/components/layout/search-input.svelte';

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

<Page>
	<PageHeader
		title="Paths"
		description="Store paths across every cache you can read, newest first."
	/>

	<div class="mb-3 flex flex-wrap items-center gap-3">
		<Select.Root
			type="single"
			value={selectedCache}
			onValueChange={(v) => applyFilters({ cache: v === ALL ? null : v })}
		>
			<Select.Trigger
				size="default"
				class="w-48 bg-background shadow-(--shadow-panel)"
				aria-label="Filter by cache"
			>
				<span data-slot="select-value" class={data.cacheFilter ? 'font-mono text-[0.8125rem]' : ''}>
					{data.cacheFilter ?? 'All caches'}
				</span>
			</Select.Trigger>
			<Select.Content>
				<Select.Item value={ALL}>All caches</Select.Item>
				{#each data.caches as name (name)}
					<Select.Item value={name} class="font-mono text-[0.8125rem]">{name}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<SearchInput value={data.q} oninput={onSearchInput} aria-label="Filter paths by name" />
		<span class="ms-auto text-sm whitespace-nowrap text-muted-foreground tabular-nums">
			{formatCount(data.total)}{data.q ? ' matching' : ' paths'}
		</span>
	</div>

	{#if data.total === 0 && !data.q}
		<EmptyState
			icon={FolderSearch}
			title={data.cacheFilter ? 'This cache is empty' : 'No store paths yet'}
			description="Paths pushed with the nimbus CLI or attic appear here."
		/>
	{:else}
		{#if data.paths.length === 0}
			<EmptyState
				icon={Search}
				title="No paths match “{data.q}”"
				description="Try a shorter name, or a different cache."
			/>
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
			<p class="text-xs text-muted-foreground tabular-nums">
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
</Page>
