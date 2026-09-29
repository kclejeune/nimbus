<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ArrowLeft, ShieldX, SearchX, TriangleAlert } from '@lucide/svelte';

	const status = $derived(page.status);
	const message = $derived(page.error?.message ?? 'Something went wrong');

	const view = $derived.by(() => {
		if (status === 403) {
			return {
				icon: ShieldX,
				title: 'No access',
				text:
					message === 'Permission denied' || message === 'Admins only'
						? 'Ask an admin for a grant if you need this page.'
						: message
			};
		}
		if (status === 404) return { icon: SearchX, title: 'Page not found', text: message };
		return { icon: TriangleAlert, title: 'Something went wrong', text: message, code: status };
	});
</script>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
	<div
		class="flex size-12 items-center justify-center rounded-xl border bg-card shadow-(--shadow-panel)"
	>
		<view.icon class="size-6 text-muted-foreground" />
	</div>
	<div class="space-y-1.5">
		<h1 class="text-xl font-semibold tracking-[-0.02em]">{view.title}</h1>
		{#if view.code}
			<p class="font-mono text-xs text-muted-foreground">Error {view.code}</p>
		{/if}
		<p class="max-w-md text-sm text-muted-foreground">{view.text}</p>
	</div>
	<Button variant="outline" href="/">
		<ArrowLeft />
		Back to overview
	</Button>
</div>
