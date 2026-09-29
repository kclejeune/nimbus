<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

	let {
		tone = 'neutral',
		dot = false,
		title,
		class: className,
		children
	}: {
		tone?: Tone;
		/** A leading dot marks live state (active, pending) rather than a label. */
		dot?: boolean;
		title?: string;
		class?: string;
		children: Snippet;
	} = $props();

	const tones: Record<Tone, string> = {
		neutral: 'bg-muted text-muted-foreground ring-border',
		primary: 'bg-accent text-accent-foreground ring-primary/20',
		success: 'bg-success/10 text-success ring-success/25',
		warning: 'bg-warning/12 text-warning ring-warning/30',
		danger: 'bg-destructive/10 text-destructive ring-destructive/25'
	};
</script>

<span
	{title}
	class={cn(
		'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] px-1.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
		tones[tone],
		className
	)}
>
	{#if dot}<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>{/if}
	{@render children()}
</span>
