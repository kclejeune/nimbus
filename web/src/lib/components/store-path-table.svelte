<script lang="ts" module>
	export interface StorePathTableRow {
		/** Detail-page link; null renders an unlinked muted row (e.g. a
		 *  reference not resolvable in the cache). */
		href: string | null;
		/** Full /nix/store path; null falls back to the hash + note. */
		storePath: string | null;
		hash: string;
		createdAt: string | null;
		narSize: number | null;
		/** Present when the table shows its Cache column. */
		cache?: { name: string; href: string };
		/** Annotation after the path (e.g. where an unresolved reference
		 *  actually lives); unlinked rows default to "not in this cache". */
		note?: string;
	}

	type SortKey = 'path' | 'cache' | 'added' | 'size';
</script>

<script lang="ts">
	import { formatBytes, formatCount, formatIsoDate, shortStorePath } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ChevronDown, ChevronUp, Search } from '@lucide/svelte';

	let {
		rows,
		showCache = false,
		interactive = false,
		pageSize = 25
	}: {
		rows: StorePathTableRow[];
		showCache?: boolean;
		/** Client-side search, sortable headers, and pagination. Leave off for
		 *  tables whose filtering/paging is server-driven (the /paths explorer). */
		interactive?: boolean;
		pageSize?: number;
	} = $props();

	let q = $state('');
	let sortKey = $state<SortKey | null>(null);
	let sortAsc = $state(true);
	let page = $state(1);

	// Comparable value per column; nulls sort last in either direction.
	function keyOf(row: StorePathTableRow, key: SortKey): string | number | null {
		switch (key) {
			case 'path':
				return row.storePath ? shortStorePath(row.storePath) : row.hash;
			case 'cache':
				return row.cache?.name ?? null;
			case 'added':
				return row.createdAt;
			case 'size':
				return row.narSize;
		}
	}

	const filtered = $derived.by(() => {
		if (!interactive) return rows;
		const term = q.trim().toLowerCase();
		if (!term) return rows;
		return rows.filter(
			(row) =>
				(row.storePath ?? row.hash).toLowerCase().includes(term) ||
				(showCache && row.cache?.name.toLowerCase().includes(term))
		);
	});

	const sorted = $derived.by(() => {
		if (!interactive || sortKey === null) return filtered;
		const key = sortKey;
		const flip = sortAsc ? 1 : -1;
		return [...filtered].sort((a, b) => {
			const va = keyOf(a, key);
			const vb = keyOf(b, key);
			if (va === null && vb === null) return 0;
			if (va === null) return 1;
			if (vb === null) return -1;
			const cmp =
				typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb));
			return cmp * flip;
		});
	});

	const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / pageSize)));
	const currentPage = $derived(Math.min(page, totalPages));
	const paged = $derived(
		interactive ? sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize) : sorted
	);
	const first = $derived((currentPage - 1) * pageSize + 1);
	const last = $derived(first + paged.length - 1);

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortAsc = !sortAsc;
		} else {
			sortKey = key;
			sortAsc = true;
		}
		page = 1;
	}
</script>

{#snippet sortableHeader(key: SortKey, label: string, alignRight?: boolean)}
	{#if interactive}
		<button
			type="button"
			class="inline-flex items-center gap-1 font-medium hover:text-foreground {alignRight
				? 'justify-end'
				: ''}"
			onclick={() => toggleSort(key)}
			aria-label="Sort by {label}"
		>
			{label}
			{#if sortKey === key}
				{#if sortAsc}<ChevronUp class="size-3" />{:else}<ChevronDown class="size-3" />{/if}
			{/if}
		</button>
	{:else}
		{label}
	{/if}
{/snippet}

{#if interactive && (rows.length > pageSize || q)}
	<div class="relative mb-3 max-w-xs">
		<Search
			class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<input
			type="search"
			placeholder="Filter by name…"
			class="h-8 w-full rounded-md border border-input bg-background pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
			bind:value={q}
			oninput={() => (page = 1)}
		/>
	</div>
{/if}

<div class="overflow-x-auto rounded-lg border">
	<table class="w-full text-sm">
		<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
			<tr>
				<th class="px-4 py-2.5 font-medium">{@render sortableHeader('path', 'Store path')}</th>
				{#if showCache}
					<th class="w-28 px-4 py-2.5 font-medium">{@render sortableHeader('cache', 'Cache')}</th>
				{/if}
				<th class="w-32 px-4 py-2.5 font-medium">{@render sortableHeader('added', 'Added')}</th>
				<th class="w-28 px-4 py-2.5 text-right font-medium">
					{@render sortableHeader('size', 'NAR size', true)}
				</th>
			</tr>
		</thead>
		<tbody class="divide-y">
			{#each paged as row (`${row.cache?.name ?? ''}/${row.hash}`)}
				<tr class="transition-colors hover:bg-muted/30">
					{#if row.href && row.storePath}
						<td class="px-4 py-2.5 font-mono text-xs break-all">
							<a href={row.href} class="hover:text-primary hover:underline">
								{shortStorePath(row.storePath)}
							</a>
							{#if row.note}
								<span class="ml-1 font-sans text-muted-foreground">{row.note}</span>
							{/if}
						</td>
					{:else}
						<td class="px-4 py-2.5 font-mono text-xs break-all text-muted-foreground">
							{row.storePath ? shortStorePath(row.storePath) : row.hash}
							<span class="ml-1 font-sans">{row.note ?? 'not in this cache'}</span>
						</td>
					{/if}
					{#if showCache}
						<td class="px-4 py-2.5 font-mono text-xs">
							{#if row.cache}
								<a href={row.cache.href} class="hover:underline">{row.cache.name}</a>
							{/if}
						</td>
					{/if}
					<td class="px-4 py-2.5 font-mono text-xs text-muted-foreground">
						{formatIsoDate(row.createdAt)}
					</td>
					<td class="px-4 py-2.5 text-right font-mono">
						{row.narSize == null ? '—' : formatBytes(row.narSize)}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>

	{#if interactive && paged.length === 0}
		<p class="py-8 text-center text-sm text-muted-foreground">No rows match “{q}”.</p>
	{/if}
</div>

{#if interactive && sorted.length > pageSize}
	<div class="mt-3 flex flex-wrap items-center justify-between gap-3">
		<p class="text-xs text-muted-foreground">
			Showing {formatCount(first)}–{formatCount(last)} of {formatCount(sorted.length)}
		</p>
		<div class="flex items-center gap-2">
			<Button
				variant="outline"
				size="sm"
				disabled={currentPage <= 1}
				onclick={() => (page = currentPage - 1)}
			>
				Previous
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={currentPage >= totalPages}
				onclick={() => (page = currentPage + 1)}
			>
				Next
			</Button>
		</div>
	</div>
{/if}
