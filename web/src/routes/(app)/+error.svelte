<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ArrowLeft, ShieldX, SearchX, TriangleAlert } from '@lucide/svelte';

	const status = $derived(page.status);
	const message = $derived(page.error?.message ?? 'Something went wrong');
</script>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
	{#if status === 403}
		<ShieldX class="size-10 text-muted-foreground" />
		<div class="space-y-1.5">
			<h1 class="text-xl font-semibold tracking-tight">You don't have access to this</h1>
			<p class="max-w-md text-sm text-muted-foreground">
				{message === 'Permission denied' || message === 'Admins only'
					? 'This page needs permissions your account doesn’t have. Ask an administrator for a grant if you think you should have access.'
					: message}
			</p>
		</div>
	{:else if status === 404}
		<SearchX class="size-10 text-muted-foreground" />
		<div class="space-y-1.5">
			<h1 class="text-xl font-semibold tracking-tight">Not found</h1>
			<p class="max-w-md text-sm text-muted-foreground">{message}</p>
		</div>
	{:else}
		<TriangleAlert class="size-10 text-muted-foreground" />
		<div class="space-y-1.5">
			<h1 class="text-xl font-semibold tracking-tight">{status}</h1>
			<p class="max-w-md text-sm text-muted-foreground">{message}</p>
		</div>
	{/if}
	<Button variant="outline" href="/">
		<ArrowLeft class="size-4" />
		Back to overview
	</Button>
</div>
