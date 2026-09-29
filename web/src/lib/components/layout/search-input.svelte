<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { Search } from '@lucide/svelte';
	import { cn } from '$lib/utils.js';

	let {
		value = $bindable(),
		class: className,
		placeholder = 'Filter by name',
		...rest
	}: Omit<HTMLInputAttributes, 'type'> = $props();
</script>

<div class={cn('relative w-72 max-w-full', className)}>
	<Search
		class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
		aria-hidden="true"
	/>
	<input
		type="search"
		bind:value
		{placeholder}
		aria-label={rest['aria-label'] ?? placeholder}
		class="h-8 w-full rounded-lg border border-input bg-background pr-3 pl-8 text-sm shadow-(--shadow-panel) transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
		{...rest}
	/>
</div>
