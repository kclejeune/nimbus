<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		width = 'default',
		class: className,
		children
	}: {
		/** `narrow` for forms and single-subject pages, `wide` for data-dense ones. */
		width?: 'narrow' | 'default' | 'wide';
		class?: string;
		children: Snippet;
	} = $props();
</script>

<!-- The one page container: every route shares its gutters and max width so
     switching sections never shifts the content edge. -->
<div
	class={cn(
		'mx-auto w-full px-4 pt-6 pb-16 sm:px-6 lg:px-10 lg:pt-8',
		width === 'narrow' && 'max-w-3xl',
		width === 'default' && 'max-w-6xl',
		width === 'wide' && 'max-w-7xl',
		className
	)}
>
	{@render children()}
</div>
