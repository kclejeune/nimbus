<script lang="ts">
	import { CircleAlert } from '@lucide/svelte';

	let {
		label,
		value,
		sub,
		alert
	}: {
		label: string;
		value: string;
		sub?: string;
		/** Flags the tile's value as out of bounds; the text says which bound. */
		alert?: string;
	} = $props();
</script>

<!-- A tile in the page's stat grids, where gap-px over bg-border draws the dividers. -->
<div class="bg-card px-5 py-4">
	<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
		{label}
		{#if alert}<CircleAlert class="size-3.5 text-destructive" aria-label={alert} />{/if}
	</div>
	<div class="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
	{#if sub}<div class="mt-1 text-xs leading-snug text-muted-foreground">{sub}</div>{/if}
</div>
