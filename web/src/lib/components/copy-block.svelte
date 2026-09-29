<script lang="ts">
	import { Copy, Check } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';

	let { text, label = 'Copy' }: { text: string; label?: string } = $props();

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

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			copy();
		}
	}
</script>

<!-- A <pre> can't live inside a <button>, so this is a keyboard-accessible
	 role=button region; clicking anywhere (or Enter/Space) copies the snippet. -->
<div
	role="button"
	tabindex="0"
	onclick={copy}
	{onkeydown}
	title={label}
	aria-label={label}
	class="group relative cursor-pointer overflow-hidden rounded-md border bg-subtle transition-colors hover:border-input"
>
	<pre class="px-3 py-2.5 pr-12 font-mono text-xs leading-5 break-all whitespace-pre-wrap"><code
			>{text}</code
		></pre>
	<span
		class="absolute top-1.5 right-1.5 flex size-8 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-(--shadow-panel) transition-colors group-hover:text-foreground"
	>
		{#if copied}
			<Check class="size-4 text-primary" />
		{:else}
			<Copy class="size-4" />
		{/if}
	</span>
</div>
