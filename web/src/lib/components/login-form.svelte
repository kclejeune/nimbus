<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import Logo from '$lib/components/logo.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';

	let {
		oidcConfigured,
		githubConfigured = false,
		accessConfigured,
		redirectTo,
		errorCode = null
	}: {
		oidcConfigured: boolean;
		githubConfigured?: boolean;
		accessConfigured: boolean;
		redirectTo: string;
		errorCode?: string | null;
	} = $props();

	let loading = $state(false);
	let errorMessage = $state('');
	// The callback-redirect error (?error=...) shows until a new attempt starts.
	let attempted = $state(false);
	const callbackError = $derived(
		errorCode === 'signup_disabled'
			? 'That GitHub account isn’t linked to a user here. Sign in with SSO first, then link GitHub from Settings.'
			: errorCode
				? `Sign-in failed (${errorCode}). Try again.`
				: ''
	);
	const displayError = $derived(errorMessage || (attempted ? '' : callbackError));

	async function signIn() {
		loading = true;
		attempted = true;
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

	async function signInGithub() {
		loading = true;
		attempted = true;
		errorMessage = '';
		const { error } = await authClient.signIn.social({
			provider: 'github',
			callbackURL: redirectTo,
			errorCallbackURL: '/login'
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
		{#if oidcConfigured || githubConfigured}
			{#if oidcConfigured}
				<Button class="w-full" onclick={signIn} disabled={loading}>
					{loading ? 'Redirecting…' : 'Sign in with SSO'}
				</Button>
			{/if}
			{#if githubConfigured}
				<Button variant="outline" class="w-full" onclick={signInGithub} disabled={loading}>
					{loading ? 'Redirecting…' : 'Sign in with GitHub'}
				</Button>
			{/if}
			{#if displayError}
				<p class="text-center text-sm text-destructive">{displayError}</p>
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
