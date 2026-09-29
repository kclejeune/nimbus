<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import AuthShell from '$lib/components/layout/auth-shell.svelte';
	import { Hourglass } from '@lucide/svelte';

	let { data } = $props();

	async function signOut() {
		// Mirrors nav-user.svelte: only an Access session needs the Access
		// logout hop; OIDC sessions clear the cookie and return to the login page.
		if (data.user.provider === 'cf-access') {
			window.location.href = '/cdn-cgi/access/logout';
			return;
		}
		await authClient.signOut();
		await goto('/login');
	}
</script>

<AuthShell title="Waiting for approval">
	<p class="text-sm leading-relaxed text-muted-foreground">
		Signed in as <span class="font-medium text-foreground">{data.user.email}</span>. An admin needs
		to activate your account. Sign in again once approved.
	</p>
	<div class="mt-5 flex items-center gap-2 border-t pt-5">
		<Hourglass class="size-4 text-warning" />
		<span class="text-sm">Pending activation</span>
		<Button variant="outline" size="sm" class="ms-auto" onclick={signOut}>Sign out</Button>
	</div>
</AuthShell>
