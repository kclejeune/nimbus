<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from '$lib/components/logo.svelte';

	let {
		title,
		description,
		children
	}: {
		title: string;
		description?: string | Snippet;
		children: Snippet;
	} = $props();
</script>

<!-- Frame for everything outside the app shell (sign-in, pending approval, CLI
     authorization): same canvas, wordmark and card treatment as the app so the
     hand-off into the dashboard doesn't change products. -->
<div class="flex min-h-svh flex-col bg-canvas">
	<header class="px-6 py-5">
		<a href="/" class="inline-flex items-center gap-2 rounded-md">
			<Logo class="size-7" />
			<span class="text-[1.0625rem] font-semibold tracking-[-0.02em]">nimbus</span>
		</a>
	</header>
	<main class="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
		<div class="w-full max-w-[25rem]">
			<div class="mb-6">
				<h1 class="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
				{#if description}
					<p class="mt-1.5 text-[0.9375rem] leading-relaxed text-muted-foreground">
						{#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
					</p>
				{/if}
			</div>
			<div class="rounded-xl border bg-card p-6 shadow-(--shadow-sheet)">
				{@render children()}
			</div>
		</div>
	</main>
</div>
