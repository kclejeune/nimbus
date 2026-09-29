<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDate } from '$lib/format';
	import { Link2, Unlink } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
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
				? await authClient.linkSocial({ provider: provider.id, callbackURL: '/account' })
				: await authClient.oauth2.link({ providerId: provider.id, callbackURL: '/account' });
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

<Page width="narrow">
	<PageHeader
		title="Account"
		description="Any linked provider signs in to the same user, tokens and role, even when the providers report different emails."
	/>

	{#if cfAccessSession}
		<Panel title="Sign-in methods">
			<p class="text-sm text-muted-foreground">
				You're signed in through Cloudflare Access, which authenticates each request and doesn't
				take part in account linking. Sign in with SSO to manage linked providers.
			</p>
		</Panel>
	{:else}
		<Panel title="Sign-in methods" flush>
			{#if data.accounts.length === 0}
				<p class="px-5 py-8 text-center text-sm text-muted-foreground">No linked providers.</p>
			{:else}
				<ul class="divide-y">
					{#each data.accounts as account (account.id)}
						<li class="flex items-center gap-4 px-5 py-3.5">
							<div
								class="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-subtle"
							>
								<Link2 class="size-4 text-muted-foreground" />
							</div>
							<div class="min-w-0 flex-1">
								<div class="text-sm font-medium">
									{providerLabels.get(account.providerId) ?? account.providerId}
								</div>
								<div class="mt-0.5 text-xs text-muted-foreground">
									Linked {formatDate(account.createdAt)}
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
								disabled={!unlinkable || busy !== ''}
								title={unlinkable ? undefined : 'You can’t unlink your only sign-in method.'}
								onclick={() => unlink(account.providerId, account.accountId)}
							>
								<Unlink /> Unlink
							</Button>
						</li>
					{/each}
				</ul>
			{/if}

			{#snippet footer()}
				{#if linkableProviders.length > 0}
					<span>Link another provider to sign in with it.</span>
					<div class="flex flex-wrap gap-2">
						{#each linkableProviders as provider (provider.id)}
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== ''}
								onclick={() => link(provider)}
							>
								{busy === provider.id ? 'Redirecting…' : `Link ${provider.label}`}
							</Button>
						{/each}
					</div>
				{:else}
					<span>Every configured provider is linked.</span>
				{/if}
			{/snippet}
		</Panel>

		{#if errorMessage}
			<p role="alert" class="mt-3 text-sm text-destructive">{errorMessage}</p>
		{/if}
	{/if}
</Page>
