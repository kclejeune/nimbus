<script lang="ts">
	import { formatCount, formatDateTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { goto } from '$app/navigation';
	import { page as pageState } from '$app/state';
	import { PAGE_SIZES } from '$lib/pagination';
	import { fitPageSize } from './page-size';

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

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Audit log</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Privileged actions across the instance, newest first.
		</p>
	</header>

	{#if data.total === 0}
		<div class="rounded-lg border border-dashed py-16 text-center">
			<p class="text-sm text-muted-foreground">No audit entries yet.</p>
		</div>
	{:else}
		<div bind:this={tableBox} class="overflow-x-auto rounded-lg border">
			<table class="w-full text-sm">
				<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
					<tr>
						<th class="px-4 py-2.5 font-medium">Time</th>
						<th class="px-4 py-2.5 font-medium">User</th>
						<th class="px-4 py-2.5 font-medium">Action</th>
						<th class="px-4 py-2.5 font-medium">Target</th>
						<th class="px-4 py-2.5 font-medium">Detail</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each data.entries as entry (entry.id)}
						<tr class="transition-colors hover:bg-muted/30">
							<td class="px-4 py-3 font-mono text-xs whitespace-nowrap text-muted-foreground">
								{formatDateTime(entry.createdAt)}
							</td>
							<td class="px-4 py-3">
								{#if entry.user}
									{entry.user}
								{:else}
									<span class="text-muted-foreground">system</span>
								{/if}
							</td>
							<td class="px-4 py-3 font-mono text-xs">{entry.action}</td>
							<td class="max-w-48 truncate px-4 py-3 font-mono text-xs" title={entry.target}>
								{entry.target ?? '—'}
							</td>
							<td class="px-4 py-3">
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

		<div class="mt-3 flex items-center justify-between gap-3">
			<p class="text-xs text-muted-foreground">
				Showing {formatCount(first)}–{formatCount(last)} of {formatCount(data.total)}
			</p>
			<div class="flex items-center gap-4">
				<div class="flex items-center gap-2">
					<span class="text-xs text-muted-foreground">Rows</span>
					<!-- Changing the page size resets to page 1: the old offset is
					     meaningless under a different stride. -->
					<div class="flex divide-x overflow-hidden rounded-md border">
						{#each PAGE_SIZES as size (size)}
							<a
								href={href(1, size)}
								data-sveltekit-noscroll
								aria-current={size === data.pageSize ? 'true' : undefined}
								class="px-2.5 py-1 text-xs transition-colors {size === data.pageSize
									? 'bg-muted font-medium text-foreground'
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
</div>
