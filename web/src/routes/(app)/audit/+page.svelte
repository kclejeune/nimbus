<script lang="ts">
	import { formatCount, formatIsoDateTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { goto } from '$app/navigation';
	import { page as pageState } from '$app/state';
	import { PAGE_SIZES } from '$lib/pagination';
	import { fitPageSize } from './page-size';
	import { ScrollText } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';

	let { data } = $props();

	const first = $derived((data.page - 1) * data.pageSize + 1);
	const last = $derived(first + data.entries.length - 1);

	/** Query string for a page/limit pair; limit is always explicit so pagination
	 *  never drifts back to the server default mid-session. */
	function href(page: number, limit: number): string {
		const params = new URLSearchParams();
		if (page > 1) params.set('page', String(page));
		params.set('limit', String(limit));
		return `?${params}`;
	}

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
	<PageHeader
		title="Audit log"
		description="Privileged actions across the instance, newest first."
	/>

	{#if data.total === 0}
		<EmptyState
			icon={ScrollText}
			title="No audit entries yet"
			description="Changes to caches, tokens, users and settings are recorded here as they happen."
		/>
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
								{#if entry.user}
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
							<td class="max-w-48 truncate font-mono text-xs" title={entry.target}>
								{entry.target ?? '—'}
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
