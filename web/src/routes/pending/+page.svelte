<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import Logo from '$lib/components/logo.svelte';
	import { Hourglass } from '@lucide/svelte';

	let { data } = $props();

	async function signOut() {
		// Mirrors nav-user.svelte: clear the better-auth session, then let
		// Cloudflare Access end its own session when it fronts this domain.
		if (data.user.provider !== 'cf-access') await authClient.signOut();
		if (data.accessConfigured) {
			window.location.href = '/cdn-cgi/access/logout';
			return;
		}
		await goto('/login');
	}
</script>

<div class="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
	<Logo class="size-10 text-primary" />
	<div class="space-y-2">
		<h1 class="inline-flex items-center gap-2 text-xl font-semibold tracking-tight">
			<Hourglass class="size-5 text-muted-foreground" /> Account awaiting approval
		</h1>
		<p class="max-w-md text-sm text-muted-foreground">
			You're signed in as <span class="font-mono">{data.user.email}</span>, but an administrator
			needs to activate your account before you can use nimbus.
		</p>
	</div>
	<Button variant="outline" onclick={signOut}>Sign out</Button>
</div>
