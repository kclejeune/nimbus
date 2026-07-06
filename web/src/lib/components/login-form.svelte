<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import Logo from '$lib/components/logo.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';

	let {
		oidcConfigured,
		accessConfigured,
		redirectTo
	}: {
		oidcConfigured: boolean;
		accessConfigured: boolean;
		redirectTo: string;
	} = $props();

	let loading = $state(false);
	let errorMessage = $state('');

	async function signIn() {
		loading = true;
		errorMessage = '';
		const { error } = await authClient.signIn.oauth2({
			providerId: 'oidc',
			callbackURL: redirectTo
		});
		if (error) {
			errorMessage = error.message ?? 'Sign-in failed. Try again.';
			loading = false;
		}
	}
</script>

<Card.Root class="mx-auto w-full max-w-sm">
	<Card.Header class="items-center text-center">
		<Logo class="mx-auto mb-2 size-10 text-primary" />
		<Card.Title class="font-mono text-xl tracking-tight">nimbus</Card.Title>
		<Card.Description>Binary cache administration</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if oidcConfigured}
			<Button class="w-full" onclick={signIn} disabled={loading}>
				{loading ? 'Redirecting…' : 'Sign in with SSO'}
			</Button>
			{#if errorMessage}
				<p class="text-center text-sm text-destructive">{errorMessage}</p>
			{/if}
		{:else if accessConfigured}
			<p class="text-center text-sm text-muted-foreground">
				This deployment authenticates through Cloudflare Access. Open the app from your Access
				dashboard to continue.
			</p>
		{:else}
			<p class="text-center text-sm text-muted-foreground">
				No sign-in method is configured. Set <span class="font-mono">OIDC_ISSUER</span> or
				<span class="font-mono">CF_ACCESS_TEAM_DOMAIN</span> for this worker.
			</p>
		{/if}
	</Card.Content>
</Card.Root>
