<script lang="ts">
	import { formatCount, formatDateTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data } = $props();

	const first = $derived((data.page - 1) * data.pageSize + 1);
	const last = $derived(first + data.entries.length - 1);
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
		<div class="overflow-x-auto rounded-lg border">
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
			<div class="flex items-center gap-2">
				{#if data.page > 1}
					<Button variant="outline" size="sm" href="?page={data.page - 1}">Previous</Button>
				{:else}
					<Button variant="outline" size="sm" disabled>Previous</Button>
				{/if}
				{#if data.hasMore}
					<Button variant="outline" size="sm" href="?page={data.page + 1}">Next</Button>
				{:else}
					<Button variant="outline" size="sm" disabled>Next</Button>
				{/if}
			</div>
		</div>
	{/if}
</div>
