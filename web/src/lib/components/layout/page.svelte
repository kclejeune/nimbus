<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let { class: className, children }: { class?: string; children: Snippet } = $props();
</script>

<!-- The one page container: every route shares its gutters, width and edges,
     so switching sections never shifts the content. -->
<div class={cn('mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-6 lg:px-10 lg:pt-8', className)}>
	{@render children()}
</div>
