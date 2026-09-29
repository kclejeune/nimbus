<script lang="ts">
	import { page } from '$app/state';
	import AuthShell from '$lib/components/layout/auth-shell.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	// Errors outside the app shell (unknown top-level URLs, auth-flow pages);
	// in-app errors render inside the sidebar layout via (app)/+error.svelte.
	const notFound = $derived(page.status === 404);
</script>

<AuthShell
	title={notFound ? 'Page not found' : 'Something went wrong'}
	description={notFound
		? 'There’s nothing at this address. Check the URL, or head back to the dashboard.'
		: (page.error?.message ?? 'The request failed.')}
>
	<div class="flex items-center justify-between gap-3">
		<span class="font-mono text-xs text-muted-foreground">Error {page.status}</span>
		<Button href="/">Go to dashboard</Button>
	</div>
</AuthShell>
