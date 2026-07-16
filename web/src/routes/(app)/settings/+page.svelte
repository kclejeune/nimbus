<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDate } from '$lib/format';
	import { Link2, Unlink } from '@lucide/svelte';
	import type { ProviderInfo } from '$lib/server/auth/providers';

	let { data } = $props();

	let busy = $state('');
	let errorMessage = $state('');

	// Labels for account rows whose provider may no longer be configured.
	const providerLabels = $derived(
		new Map<string, string>([
			['oidc', 'SSO (OIDC)'],
			...data.providers.map((p): [string, string] => [p.id, p.label])
		])
	);

	const cfAccessSession = $derived(data.sessionProvider === 'cf-access');
	const linked = $derived(new Set(data.accounts.map((a) => a.providerId)));
	const unlinkable = $derived(data.accounts.length > 1);
	const linkableProviders = $derived(data.providers.filter((p) => !linked.has(p.id)));

	async function link(provider: ProviderInfo) {
		busy = provider.id;
		errorMessage = '';
		// Both calls redirect the page to the provider and come back here.
		const { error } =
			provider.kind === 'social'
				? await authClient.linkSocial({ provider: provider.id, callbackURL: '/settings' })
				: await authClient.oauth2.link({ providerId: provider.id, callbackURL: '/settings' });
		if (error) {
			errorMessage = error.message ?? 'Linking failed. Try again.';
			busy = '';
		}
	}

	async function unlink(providerId: string, accountId: string) {
		busy = `unlink:${accountId}`;
		errorMessage = '';
		const { error } = await authClient.unlinkAccount({ providerId, accountId });
		if (error) {
			errorMessage = error.message ?? 'Unlinking failed. Try again.';
		} else {
			await invalidateAll();
		}
		busy = '';
	}
</script>

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Sign-in providers linked to your account. Any linked provider signs in to the same user,
			tokens, and role — even when the providers report different emails.
		</p>
	</header>

	<h2 class="mb-3 text-sm font-medium">Linked accounts</h2>

	{#if cfAccessSession}
		<div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
			You're signed in through Cloudflare Access, which authenticates per-request and doesn't
			participate in account linking. Sign in with SSO to manage linked providers.
		</div>
	{:else}
		{#if data.accounts.length === 0}
			<div class="rounded-lg border border-dashed py-12 text-center">
				<Link2 class="mx-auto mb-3 size-6 text-muted-foreground" />
				<p class="text-sm text-muted-foreground">No linked providers.</p>
			</div>
		{:else}
			<div class="divide-y rounded-lg border">
				{#each data.accounts as account (account.id)}
					<div class="flex items-center gap-4 px-4 py-3">
						<div class="min-w-0 flex-1">
							<span class="font-medium">
								{providerLabels.get(account.providerId) ?? account.providerId}
							</span>
							<div class="mt-0.5 text-xs text-muted-foreground">
								linked {formatDate(account.createdAt)}
							</div>
						</div>
						<Button
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-destructive"
							disabled={!unlinkable || busy !== ''}
							title={unlinkable ? undefined : 'You can’t unlink your only sign-in method.'}
							onclick={() => unlink(account.providerId, account.accountId)}
						>
							<Unlink class="size-4" /> Unlink
						</Button>
					</div>
				{/each}
			</div>
		{/if}

		{#if linkableProviders.length > 0}
			<div class="mt-4 flex flex-wrap gap-2">
				{#each linkableProviders as provider (provider.id)}
					<Button variant="outline" size="sm" disabled={busy !== ''} onclick={() => link(provider)}>
						<Link2 class="size-4" />
						{busy === provider.id ? 'Redirecting…' : `Link ${provider.label}`}
					</Button>
				{/each}
			</div>
		{/if}

		{#if errorMessage}
			<p class="mt-3 text-sm text-destructive">{errorMessage}</p>
		{/if}
	{/if}
</div>
