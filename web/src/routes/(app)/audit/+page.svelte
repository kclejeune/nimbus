<script lang="ts">
	import { formatCount, formatIsoDateTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { replaceQuery } from '$lib/url-state';
	import { page as pageState } from '$app/state';
	import { PAGE_SIZES } from '$lib/pagination';
	import { fitPageSize } from './page-size';
	import { ScrollText, SearchX } from '@lucide/svelte';
	import SearchInput from '$lib/components/layout/search-input.svelte';
	import FilterMenu from '$lib/components/filter-menu.svelte';
	import { SYSTEM_USER, auditFilterParams } from '$lib/audit-filters';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import Pager from '$lib/components/layout/pager.svelte';
	import Segmented from '$lib/components/layout/segmented.svelte';

	let { data } = $props();

	const first = $derived((data.page - 1) * data.pageSize + 1);
	const last = $derived(first + data.entries.length - 1);

	type FilterPatch = Partial<{ users: string[]; actions: string[]; q: string }>;

	/** Query string for a page/limit pair under the current filters (optionally
	 *  patched); limit is always explicit so pagination never drifts back to the
	 *  server default mid-session. */
	function href(page: number, limit: number, patch: FilterPatch = {}): string {
		const params = auditFilterParams({ ...data.filters, ...patch });
		if (page > 1) params.set('page', String(page));
		params.set('limit', String(limit));
		return `?${params}`;
	}

	/** Any filter change starts over at page 1: the old offset is meaningless
	 *  once the matching set changes. */
	function applyFilter(patch: FilterPatch) {
		replaceQuery(href(1, data.pageSize, patch));
	}

	// System first, then everyone who has acted.
	const userOptions = $derived([
		{ value: SYSTEM_USER, label: 'System' },
		...data.actors.map((a) => ({ value: a.id, label: a.label, group: 'Users' }))
	]);
	// A family entry (`cache.*`) heads each group; picking it covers the
	// family, picking single actions narrows to those.
	const actionOptions = $derived(
		data.actionGroups.flatMap((g) => [
			{ value: `${g.family}.*`, label: `All ${g.family} actions`, group: g.family },
			...g.actions.map((a) => ({ value: a, label: a, group: g.family, mono: true }))
		])
	);
	const noFilters = { users: [], actions: [], q: '' };

	// Viewport-fit default: on first load without an explicit ?limit, pick the
	// largest allowed page size whose rows fit below the table's top edge and
	// correct the URL once. An explicit param always wins (effect skips), and
	// the corrective navigation itself sets the param, so this self-terminates.
	let tableBox = $state<HTMLElement>();
	let autoSized = false;
	$effect(() => {
		if (autoSized || !tableBox) return;
		autoSized = true;
		if (pageState.url.searchParams.has('limit')) return;
		// Space from the table's top to the viewport bottom, minus the header row
		// and the pagination footer below the table.
		const top = tableBox.getBoundingClientRect().top;
		const available =
			window.innerHeight - top - 37 /* .data-table thead: h-9 + border */ - 56; /* footer */
		const best = fitPageSize(available);
		if (best !== data.pageSize) {
			replaceQuery(href(1, best));
		}
	});
</script>

<Page>
	<PageHeader title="Audit log" description="Privileged actions, newest first." />

	{#if data.total > 0 || data.filtered}
		<div class="mb-4 flex flex-wrap items-center gap-2">
			<FilterMenu
				label="Filter by user"
				noun="users"
				allLabel="Everyone"
				options={userOptions}
				selected={data.filters.users}
				onchange={(users) => applyFilter({ users })}
			/>
			<FilterMenu
				label="Filter by action"
				noun="actions"
				allLabel="All actions"
				options={actionOptions}
				selected={data.filters.actions}
				onchange={(actions) => applyFilter({ actions })}
			/>
			<SearchInput
				value={data.filters.q}
				onsearch={(q) => applyFilter({ q })}
				placeholder="Search target or detail"
				class="w-64"
			/>
			{#if data.filtered}
				<Button
					variant="ghost"
					size="sm"
					href={href(1, data.pageSize, noFilters)}
					data-sveltekit-noscroll
				>
					Clear filters
				</Button>
			{/if}
		</div>
	{/if}

	{#if data.total === 0 && data.filtered}
		<EmptyState icon={SearchX} title="No entries match">
			{#snippet action()}
				<Button variant="outline" href={href(1, data.pageSize, noFilters)} data-sveltekit-noscroll
					>Clear filters</Button
				>
			{/snippet}
		</EmptyState>
	{:else if data.total === 0}
		<EmptyState icon={ScrollText} title="No audit entries yet" />
	{:else}
		<div bind:this={tableBox} class="table-frame">
			<table class="data-table">
				<thead>
					<tr>
						<th>Time</th>
						<th>User</th>
						<th>Action</th>
						<th>Target</th>
						<th>Detail</th>
					</tr>
				</thead>
				<tbody>
					{#each data.entries as entry (entry.id)}
						<tr>
							<td class="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
								{formatIsoDateTime(entry.createdAt)}
							</td>
							<td>
								{#if entry.user && entry.userId}
									<a href="/users/{entry.userId}" class="row-link font-normal">{entry.user}</a>
								{:else if entry.user}
									{entry.user}
								{:else}
									<span class="text-muted-foreground">System</span>
								{/if}
							</td>
							<td>
								<code class="code-chip whitespace-nowrap">{entry.action}</code>
							</td>
							<td class="max-w-56 truncate text-xs" title={entry.target}>
								{#if entry.targetLink}
									<a
										href={entry.targetLink.href}
										class="font-mono text-foreground underline-offset-4 hover:text-primary hover:underline"
										>{entry.targetLink.label}</a
									>
								{:else if entry.target}
									<span class="font-mono text-muted-foreground">{entry.target}</span>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</td>
							<td>
								{#if entry.detail}
									<span
										class="block max-w-md truncate font-mono text-xs text-muted-foreground"
										title={entry.detail}
									>
										{entry.detail}
									</span>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="mt-3 flex flex-wrap items-center justify-between gap-3">
			<p class="text-xs text-muted-foreground tabular-nums">
				Showing {formatCount(first)}–{formatCount(last)} of {formatCount(data.total)}
			</p>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div class="flex items-center gap-2">
					<span class="text-xs text-muted-foreground">Rows</span>
					<!-- Changing the page size resets to page 1: the old offset is
					     meaningless under a different stride. -->
					<Segmented
						label="Rows per page"
						options={PAGE_SIZES.map((n) => [String(n), String(n)])}
						value={String(data.pageSize)}
						onpick={(size) => replaceQuery(href(1, Number(size)))}
					/>
				</div>
				<Pager page={data.page} hasMore={data.hasMore} href={(p) => href(p, data.pageSize)} />
			</div>
		</div>
	{/if}
</Page>
