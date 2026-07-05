<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data } = $props();
	let loading = $state(false);
	let errorMessage = $state('');

	async function signIn() {
		loading = true;
		errorMessage = '';
		const { error } = await authClient.signIn.oauth2({
			providerId: 'oidc',
			callbackURL: data.redirectTo
		});
		if (error) {
			errorMessage = error.message ?? 'Sign-in failed. Try again.';
			loading = false;
		}
	}
</script>

<div class="flex min-h-svh items-center justify-center bg-background px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 flex flex-col items-center text-center">
			<svg viewBox="0 0 24 24" class="mb-4 size-10 text-primary" aria-hidden="true">
				<path
					fill="currentColor"
					d="M12 1.5 8.5 7.5H2l3.25 5.62L2 18.75h6.5L12 24.75l3.5-6h6.5l-3.25-5.63L22 7.5h-6.5L12 1.5Zm0 4.2 1.9 3.3H10.1L12 5.7Zm-6.6 3.3h3.8L7.3 12.3 5.4 9Zm9.4 0h3.8L16.7 12.3 14.8 9Zm-4.7 3.3h3.8L12 18.6l-1.9-3.3Z"
				/>
			</svg>
			<h1 class="font-mono text-xl font-semibold tracking-tight">attic</h1>
			<p class="mt-1 text-sm text-muted-foreground">Binary cache administration</p>
		</div>

		{#if data.oidcConfigured}
			<Button class="w-full" onclick={signIn} disabled={loading}>
				{loading ? 'Redirecting…' : 'Sign in with SSO'}
			</Button>
			{#if errorMessage}
				<p class="mt-3 text-center text-sm text-destructive">{errorMessage}</p>
			{/if}
		{:else if data.accessConfigured}
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
	</div>
</div>
