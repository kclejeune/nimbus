<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDate } from '$lib/format';
	import { KeyRound, Link2, ShieldCheck, Unlink } from '@lucide/svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import type { ProviderInfo } from '$lib/server/auth/providers';

	let { data } = $props();

	const me = $derived(data.user);
	// Direct grants first, then inherited ones, as one list of "what can I do where".
	const accessRows = $derived([
		...data.access.grants.map((g) => ({ ...g, via: null as string | null })),
		...data.access.viaGroups.map((g) => ({ ...g, via: g.group_name }))
	]);

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
	<PageHeader title={me.name || me.email || 'Profile'}>
		{#snippet meta()}
			{#if me.email && me.name}<span>{me.email}</span>{/if}
			{#if me.role === 'admin'}
				<span class="inline-flex items-center gap-1.5 font-medium text-foreground">
					<ShieldCheck class="size-3.5 text-primary" /> Admin
				</span>
			{:else}
				<span>Member</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			<Button variant="outline" href="/tokens"><KeyRound /> Your tokens</Button>
		{/snippet}
	</PageHeader>

	<section aria-labelledby="access-heading" class="mb-8">
		<h2 id="access-heading" class="mb-1 text-base font-semibold">Your access</h2>
		<p class="mb-3 text-sm text-muted-foreground">
			{#if me.role === 'admin'}
				As an admin you hold every permission on every cache; the grants below apply only if you
				become a member.
			{:else}
				What you can do on each cache. Patterns like <code class="font-mono text-[0.8125rem]"
					>ci-*</code
				> cover every matching cache, including ones created later. Ask an admin to change these.
			{/if}
		</p>
		<div class="table-frame">
			<table class="data-table">
				<thead>
					<tr>
						<th>Cache</th>
						<th>Permissions</th>
						<th>Granted through</th>
					</tr>
				</thead>
				<tbody>
					{#each accessRows as row (row.id)}
						<tr>
							<td>
								<code class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs"
									>{row.pattern === '*' ? 'All caches' : row.pattern}</code
								>
							</td>
							<td class="text-muted-foreground">{formatGrantActions(row.actions)}</td>
							<td>
								{#if row.via}
									<span class="text-muted-foreground">Group</span>
									<span class="font-medium">{row.via}</span>
								{:else}
									<span class="text-muted-foreground">Granted to you directly</span>
								{/if}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="3" class="py-6 text-center text-sm text-muted-foreground">
								No cache access yet. You can still read public caches and create your own.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.access.memberships.length > 0}
			<p class="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				Member of
				{#each data.access.memberships as g (g.id)}
					<StatusBadge
						title={g.source === 'sso' ? 'Membership synced from the SSO groups claim' : undefined}
						>{g.name}</StatusBadge
					>
				{/each}
			</p>
		{/if}
	</section>

	<h2 class="mb-1 text-base font-semibold">Sign-in methods</h2>
	<p class="mb-3 text-sm text-muted-foreground">
		Any linked provider signs in to the same user, tokens and role, even when the providers report
		different emails.
	</p>

	{#if cfAccessSession}
		<Panel>
			<p class="text-sm text-muted-foreground">
				You're signed in through Cloudflare Access, which authenticates each request and doesn't
				take part in account linking. Sign in with SSO to manage linked providers.
			</p>
		</Panel>
	{:else}
		<Panel flush>
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
