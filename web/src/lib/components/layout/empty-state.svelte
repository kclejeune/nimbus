<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		icon: Icon,
		title,
		description,
		action,
		class: className
	}: {
		icon?: Component<{ class?: string }>;
		title: string;
		description?: string;
		action?: Snippet;
		class?: string;
	} = $props();
</script>

<div
	class={cn(
		'flex flex-col items-center rounded-lg border border-dashed bg-subtle/60 px-6 py-14 text-center',
		className
	)}
>
	{#if Icon}
		<div
			class="mb-4 flex size-10 items-center justify-center rounded-lg border bg-card shadow-(--shadow-panel)"
		>
			<Icon class="size-5 text-muted-foreground" />
		</div>
	{/if}
	<p class="text-sm font-medium">{title}</p>
	{#if description}
		<p class="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
	{/if}
	{#if action}
		<div class="mt-5">{@render action()}</div>
	{/if}
</div>
