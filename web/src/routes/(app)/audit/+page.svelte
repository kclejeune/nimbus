<script lang="ts">
	import { formatCount, formatIsoDateTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { goto } from '$app/navigation';
	import { page as pageState } from '$app/state';
	import { PAGE_SIZES } from '$lib/pagination';
	import { fitPageSize } from './page-size';
	import { ScrollText, SearchX } from '@lucide/svelte';
	import SearchInput from '$lib/components/layout/search-input.svelte';
	import { SYSTEM_USER } from '$lib/audit-filters';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';

	let { data } = $props();

	const first = $derived((data.page - 1) * data.pageSize + 1);
	const last = $derived(first + data.entries.length - 1);

	type FilterPatch = Partial<{ user: string | null; action: string | null; q: string }>;

	/** Query string for a page/limit pair under the current filters (optionally
	 *  patched); limit is always explicit so pagination never drifts back to the
	 *  server default mid-session. */
	function href(page: number, limit: number, patch: FilterPatch = {}): string {
		const f = { ...data.filters, ...patch };
		const params = new URLSearchParams();
		if (f.user) params.set('user', f.user);
		if (f.action) params.set('action', f.action);
		if (f.q) params.set('q', f.q);
		if (page > 1) params.set('page', String(page));
		params.set('limit', String(limit));
		return `?${params}`;
	}

	/** Any filter change starts over at page 1: the old offset is meaningless
	 *  once the matching set changes. */
	function applyFilter(patch: FilterPatch) {
		goto(href(1, data.pageSize, patch), { replaceState: true, keepFocus: true, noScroll: true });
	}

	let debounce: ReturnType<typeof setTimeout>;
	function onSearchInput(e: Event & { currentTarget: HTMLInputElement }) {
		const v = e.currentTarget.value.trim();
		clearTimeout(debounce);
		debounce = setTimeout(() => applyFilter({ q: v }), 300);
	}

	// A user id from a shared link that isn't in the actor list still gets a
	// selectable option, so the select reflects the active filter.
	const actorOptions = $derived(
		data.filters.user &&
			data.filters.user !== SYSTEM_USER &&
			!data.actors.some((a) => a.id === data.filters.user)
			? [...data.actors, { id: data.filters.user, label: data.filters.user }]
			: data.actors
	);

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
		const available = window.innerHeight - top - 34 /* thead */ - 56; /* footer */
		const best = fitPageSize(available);
		if (best !== data.pageSize) {
			goto(href(1, best), { replaceState: true, keepFocus: true, noScroll: true });
		}
	});
</script>

<Page>
	<PageHeader title="Audit log" description="Privileged actions, newest first." />

	{#if data.total > 0 || data.filtered}
		<div class="mb-4 flex flex-wrap items-center gap-2">
			<select
				aria-label="Filter by user"
				class="native-select w-48"
				value={data.filters.user ?? ''}
				onchange={(e) => applyFilter({ user: e.currentTarget.value || null })}
			>
				<option value="">Everyone</option>
				<option value={SYSTEM_USER}>System</option>
				{#each actorOptions as actor (actor.id)}
					<option value={actor.id}>{actor.label}</option>
				{/each}
			</select>
			<select
				aria-label="Filter by action"
				class="native-select w-52"
				value={data.filters.action ?? ''}
				onchange={(e) => applyFilter({ action: e.currentTarget.value || null })}
			>
				<option value="">All actions</option>
				{#each data.actionGroups as group (group.family)}
					<optgroup label={group.family}>
						<option value="{group.family}.*">All {group.family} actions</option>
						{#each group.actions as action (action)}
							<option value={action}>{action}</option>
						{/each}
					</optgroup>
				{/each}
			</select>
			<SearchInput
				value={data.filters.q}
				oninput={onSearchInput}
				placeholder="Search target or detail"
				class="w-64"
			/>
			{#if data.filtered}
				<Button
					variant="ghost"
					size="sm"
					href={href(1, data.pageSize, { user: null, action: null, q: '' })}
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
				<Button
					variant="outline"
					href={href(1, data.pageSize, { user: null, action: null, q: '' })}
					data-sveltekit-noscroll>Clear filters</Button
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
								<code
									class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs whitespace-nowrap"
									>{entry.action}</code
								>
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
					<div
						class="flex divide-x overflow-hidden rounded-lg border bg-background shadow-(--shadow-panel)"
					>
						{#each PAGE_SIZES as size (size)}
							<a
								href={href(1, size)}
								data-sveltekit-noscroll
								aria-current={size === data.pageSize ? 'true' : undefined}
								class="px-2.5 py-1 text-xs transition-colors {size === data.pageSize
									? 'bg-accent font-medium text-accent-foreground'
									: 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}"
							>
								{size}
							</a>
						{/each}
					</div>
				</div>
				<div class="flex items-center gap-2">
					{#if data.page > 1}
						<Button variant="outline" size="sm" href={href(data.page - 1, data.pageSize)}>
							Previous
						</Button>
					{:else}
						<Button variant="outline" size="sm" disabled>Previous</Button>
					{/if}
					{#if data.hasMore}
						<Button variant="outline" size="sm" href={href(data.page + 1, data.pageSize)}>
							Next
						</Button>
					{:else}
						<Button variant="outline" size="sm" disabled>Next</Button>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</Page>
