<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ArrowLeft, ShieldX, SearchX, TriangleAlert } from '@lucide/svelte';

	const status = $derived(page.status);
	const message = $derived(page.error?.message ?? 'Something went wrong');
</script>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
	{#if status === 403}
		<div
			class="flex size-12 items-center justify-center rounded-xl border bg-card shadow-(--shadow-panel)"
		>
			<ShieldX class="size-6 text-muted-foreground" />
		</div>
		<div class="space-y-1.5">
			<h1 class="text-xl font-semibold tracking-[-0.02em]">You don't have access to this</h1>
			<p class="max-w-md text-sm text-muted-foreground">
				{message === 'Permission denied' || message === 'Admins only'
					? 'This page needs permissions your account doesn’t have. Ask an administrator for a grant if you think you should have access.'
					: message}
			</p>
		</div>
	{:else if status === 404}
		<div
			class="flex size-12 items-center justify-center rounded-xl border bg-card shadow-(--shadow-panel)"
		>
			<SearchX class="size-6 text-muted-foreground" />
		</div>
		<div class="space-y-1.5">
			<h1 class="text-xl font-semibold tracking-[-0.02em]">Page not found</h1>
			<p class="max-w-md text-sm text-muted-foreground">{message}</p>
		</div>
	{:else}
		<div
			class="flex size-12 items-center justify-center rounded-xl border bg-card shadow-(--shadow-panel)"
		>
			<TriangleAlert class="size-6 text-muted-foreground" />
		</div>
		<div class="space-y-1.5">
			<h1 class="text-xl font-semibold tracking-[-0.02em]">Something went wrong</h1>
			<p class="font-mono text-xs text-muted-foreground">Error {status}</p>
			<p class="max-w-md text-sm text-muted-foreground">{message}</p>
		</div>
	{/if}
	<Button variant="outline" href="/">
		<ArrowLeft />
		Back to overview
	</Button>
</div>
