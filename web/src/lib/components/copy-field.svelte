<script lang="ts">
	import { Copy, Check } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';

	let {
		text,
		label = 'Copy',
		class: className = ''
	}: { text: string; label?: string; class?: string } = $props();

	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			toast.success('Copied to clipboard');
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
			toast.error('Could not copy to clipboard');
		}
	}
</script>

<button
	type="button"
	onclick={copy}
	title={label}
	aria-label={label}
	class="group flex w-full cursor-pointer items-stretch overflow-hidden rounded-md border border-input bg-muted text-left transition-colors hover:bg-accent/40 {className}"
>
	<code class="min-w-0 flex-1 truncate px-3 py-2.5 font-mono text-xs leading-5">{text}</code>
	<span
		class="flex w-10 shrink-0 items-center justify-center border-l border-input text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-accent-foreground"
	>
		{#if copied}
			<Check class="size-4 text-primary" />
		{:else}
			<Copy class="size-4" />
		{/if}
	</span>
</button>
