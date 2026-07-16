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
</script>

<script lang="ts">
	import { formatBytes, formatIsoDate, shortStorePath } from '$lib/format';

	let { rows, showCache = false }: { rows: StorePathTableRow[]; showCache?: boolean } = $props();
</script>

<div class="overflow-x-auto rounded-lg border">
	<table class="w-full text-sm">
		<thead class="border-b bg-muted text-left text-xs text-muted-foreground">
			<tr>
				<th class="px-4 py-2.5 font-medium">Store path</th>
				{#if showCache}
					<th class="w-28 px-4 py-2.5 font-medium">Cache</th>
				{/if}
				<th class="w-32 px-4 py-2.5 font-medium">Added</th>
				<th class="w-28 px-4 py-2.5 text-right font-medium">NAR size</th>
			</tr>
		</thead>
		<tbody class="divide-y">
			{#each rows as row (`${row.cache?.name ?? ''}/${row.hash}`)}
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
</div>
