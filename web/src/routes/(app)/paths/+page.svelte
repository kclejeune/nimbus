<script lang="ts">
	import { formatCount } from '$lib/format';
	import StorePathTable from '$lib/components/store-path-table.svelte';
	import { replaceQuery } from '$lib/url-state';
	import { Button } from '$lib/components/ui/button/index.js';
	import FilterMenu from '$lib/components/filter-menu.svelte';
	import { FolderSearch, Search } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import SearchInput from '$lib/components/layout/search-input.svelte';

	let { data } = $props();

	const first = $derived((data.page - 1) * data.pageSize + 1);
	const last = $derived(first + data.paths.length - 1);

	/** Query string for the current filters; page omitted when 1. */
	function href(next: { caches?: string[]; q?: string; page?: number }): string {
		const params = new URLSearchParams();
		for (const c of next.caches ?? data.cacheFilter) params.append('cache', c);
		const q = next.q ?? data.q;
		if (q) params.set('q', q);
		if ((next.page ?? 1) > 1) params.set('page', String(next.page));
		const qs = params.toString();
		return qs ? `?${qs}` : '?';
	}

	function applyFilters(next: { caches?: string[]; q?: string }) {
		// Any filter change resets to page 1 — the old offset is meaningless.
		replaceQuery(href(next));
	}
</script>

<Page>
	<PageHeader title="Paths" description="All caches you can read, newest first." />

	<div class="mb-3 flex flex-wrap items-center gap-3">
		<FilterMenu
			label="Filter by cache"
			noun="caches"
			allLabel="All caches"
			options={data.caches.map((name) => ({ value: name, label: name, mono: true }))}
			selected={data.cacheFilter}
			onchange={(caches) => applyFilters({ caches })}
		/>
		<SearchInput
			value={data.q}
			onsearch={(q) => applyFilters({ q })}
			aria-label="Filter paths by name"
		/>
		<span class="ms-auto text-sm whitespace-nowrap text-muted-foreground tabular-nums">
			{formatCount(data.total)}{data.q ? ' matching' : ' paths'}
		</span>
	</div>

	{#if data.total === 0 && !data.q}
		<EmptyState
			icon={FolderSearch}
			title={data.cacheFilter.length === 1
				? 'This cache is empty'
				: data.cacheFilter.length
					? 'These caches are empty'
					: 'No paths yet'}
			description="Push with the nimbus CLI or attic."
		/>
	{:else}
		{#if data.paths.length === 0}
			<EmptyState icon={Search} title="No paths match “{data.q}”" />
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
