<script lang="ts">
	import { splitStorePath } from '$lib/format';
	import { cn } from '$lib/utils.js';

	let {
		path,
		href,
		full = false,
		wide = false,
		class: className
	}: {
		/** A full /nix/store path, or just `<hash>-<name>`. */
		path: string;
		href?: string;
		/** Show the whole hash instead of its first 8 characters. */
		full?: boolean;
		/** Show the whole hash on wide screens (xl+), 8 characters below. For
		 *  full-width tables, where there's room to match `nix path-info` output. */
		wide?: boolean;
		class?: string;
	} = $props();

	// /nix/store/<32-char base32 hash>-<name>. The hash identifies, the name is
	// what people scan for — so the name carries the weight and the hash recedes.
	const parts = $derived(splitStorePath(path));
</script>

<svelte:element
	this={href ? 'a' : 'span'}
	{href}
	title={path}
	class={cn(
		'group/sp inline-flex max-w-full min-w-0 items-baseline font-mono text-[0.8125rem]',
		href && 'rounded-sm outline-offset-2',
		className
	)}
>
	{#if parts.hash}
		<span class="shrink-0 text-muted-foreground/70"
			>{parts.hash.slice(0, 8)}{#if full}{parts.hash.slice(8)}{:else if wide}<span
					class="hidden xl:inline">{parts.hash.slice(8)}</span
				><span class="xl:hidden">…</span>{:else}…{/if}-</span
		>
	{/if}
	<span
		class={cn(
			'truncate font-medium text-foreground',
			href && 'underline-offset-4 group-hover/sp:text-primary group-hover/sp:underline'
		)}>{parts.name}</span
	>
</svelte:element>
