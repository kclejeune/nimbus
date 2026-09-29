<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		title,
		description,
		mono = false,
		meta,
		actions,
		class: className
	}: {
		title: string;
		description?: string | Snippet;
		/** Render the title in mono: for identifiers like cache names. */
		mono?: boolean;
		/** Inline facts under the title (visibility, counts…). */
		meta?: Snippet;
		actions?: Snippet;
		class?: string;
	} = $props();
</script>

<!-- Title and actions share the top row; the description and meta run full
     width beneath, so a button never squeezes the text into a narrow column. -->
<header class={cn('mb-8', className)}>
	<div class="flex items-start justify-between gap-x-6 gap-y-3 max-sm:flex-wrap">
		<h1
			class={cn(
				'min-w-0 text-[1.625rem] leading-tight font-semibold tracking-[-0.02em] text-balance',
				mono && 'font-mono text-2xl tracking-[-0.03em] break-all'
			)}
		>
			{title}
		</h1>
		{#if actions}
			<div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
	{#if description}
		<p class="mt-1.5 max-w-2xl text-[0.9375rem] leading-relaxed text-muted-foreground">
			{#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
		</p>
	{/if}
	{#if meta}
		<div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
			{@render meta()}
		</div>
	{/if}
</header>
