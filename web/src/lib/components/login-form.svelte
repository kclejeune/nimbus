<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { ProviderInfo } from '$lib/server/auth/providers';

	let {
		providers,
		accessConfigured,
		redirectTo,
		errorCode = null
	}: {
		providers: ProviderInfo[];
		accessConfigured: boolean;
		redirectTo: string;
		errorCode?: string | null;
	} = $props();

	let loading = $state(false);
	let errorMessage = $state('');
	// The callback-redirect error (?error=...) shows until a new attempt starts.
	const callbackError = $derived(
		errorCode === 'signup_disabled'
			? 'That account isn’t linked to a user here. Sign in with SSO, then link it from your profile.'
			: errorCode
				? `Sign-in failed (${errorCode}). Try again.`
				: ''
	);
	const displayError = $derived(loading ? '' : errorMessage || callbackError);

	async function signIn(provider: ProviderInfo) {
		loading = true;
		errorMessage = '';
		const { error } =
			provider.kind === 'social'
				? await authClient.signIn.social({
						provider: provider.id,
						callbackURL: redirectTo,
						errorCallbackURL: '/login'
					})
				: await authClient.signIn.oauth2({
						providerId: provider.id,
						callbackURL: redirectTo,
						errorCallbackURL: '/login'
					});
		if (error) {
			errorMessage = error.message ?? 'Sign-in failed. Try again.';
			loading = false;
		}
	}
</script>

<div class="flex flex-col gap-2.5">
	{#if providers.length > 0}
		{#each providers as provider, i (provider.id)}
			<Button
				variant={i === 0 ? 'default' : 'outline'}
				size="lg"
				class="w-full"
				onclick={() => signIn(provider)}
				disabled={loading}
			>
				{loading ? 'Redirecting…' : `Continue with ${provider.label}`}
			</Button>
		{/each}
		{#if displayError}
			<p role="alert" class="mt-1 text-sm text-destructive">{displayError}</p>
		{/if}
	{:else if accessConfigured}
		<p class="text-sm text-muted-foreground">
			Sign-in goes through Cloudflare Access. Open the app from your Access dashboard.
		</p>
	{:else}
		<p class="text-sm text-muted-foreground">
			No sign-in method is configured. Set <code class="font-mono text-[0.8125rem]"
				>OIDC_ISSUER</code
			>
			or <code class="font-mono text-[0.8125rem]">CF_ACCESS_TEAM_DOMAIN</code> for this worker.
		</p>
	{/if}
</div>
