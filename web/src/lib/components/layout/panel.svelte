<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		title,
		description,
		actions,
		footer,
		tone = 'default',
		flush = false,
		class: className,
		children
	}: {
		title?: string;
		description?: string | Snippet;
		actions?: Snippet;
		/** A band under the body for the panel's submit button or fine print. */
		footer?: Snippet;
		/** `danger` frames irreversible actions. */
		tone?: 'default' | 'danger';
		/** Drop body padding, for tables and lists that run edge to edge. */
		flush?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<section
	class={cn(
		'overflow-hidden rounded-lg border bg-card shadow-(--shadow-panel)',
		tone === 'danger' && 'border-destructive/30',
		className
	)}
>
	{#if title || actions}
		<div
			class={cn(
				'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4',
				flush && 'border-b pb-4'
			)}
		>
			<div class="min-w-0">
				{#if title}
					<h2 class={cn('text-[0.9375rem] font-semibold', tone === 'danger' && 'text-destructive')}>
						{title}
					</h2>
				{/if}
				{#if description}
					<p class="mt-0.5 max-w-prose text-sm text-muted-foreground">
						{#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
					</p>
				{/if}
			</div>
			{#if actions}
				<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
			{/if}
		</div>
	{/if}
	{#if children}
		<div class={cn(!flush && 'px-5 pt-4 pb-5', !flush && !(title || actions) && 'pt-5')}>
			{@render children()}
		</div>
	{/if}
	{#if footer}
		<div
			class="flex flex-wrap items-center justify-between gap-3 border-t bg-subtle px-5 py-3 text-sm text-muted-foreground"
		>
			{@render footer()}
		</div>
	{/if}
</section>
