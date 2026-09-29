<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		title,
		description,
		tone = 'default',
		flush = false,
		children
	}: {
		title: string;
		description?: string | Snippet;
		/** `danger` frames irreversible actions. */
		tone?: 'default' | 'danger';
		/** Drop the card's padding, for lists that run edge to edge. */
		flush?: boolean;
		children: Snippet;
	} = $props();
</script>

<!-- A settings row: what it is and why on the left, the controls on the
     right. Stacks below lg. Consecutive sections are divided by the parent. -->
<section class="grid gap-x-10 gap-y-4 py-8 first:pt-0 lg:grid-cols-[17rem_minmax(0,1fr)]">
	<div>
		<h2 class={cn('text-[0.9375rem] font-semibold', tone === 'danger' && 'text-destructive')}>
			{title}
		</h2>
		{#if description}
			<p class="mt-1 text-sm leading-relaxed text-muted-foreground">
				{#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
			</p>
		{/if}
	</div>
	<div
		class={cn(
			'min-w-0 self-start overflow-hidden rounded-lg border bg-card shadow-(--shadow-panel)',
			!flush && 'p-5',
			tone === 'danger' && 'border-destructive/30'
		)}
	>
		{@render children()}
	</div>
</section>
