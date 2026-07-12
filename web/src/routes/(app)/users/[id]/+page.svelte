<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import GrantEditor from '$lib/components/grant-editor.svelte';
	import TokenTable from '$lib/components/token-table.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { ArrowLeft, Trash2 } from '@lucide/svelte';

	let { data, form } = $props();
	const u = $derived(data.subject);
	// Viewer identity comes from the (app) layout's `user`; the server guard
	// (requireSelfOrAdmin) already enforced admin-or-self.
	const isSelf = $derived(u.id === data.user.id);
	const canManage = $derived(data.user.role === 'admin');
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	{#if canManage}
		<a
			href="/users"
			class="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
		>
			<ArrowLeft class="size-4" />
			Users
		</a>
	{/if}

	<header class="mb-8 flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
				{u.name}
				{#if u.isOwner}
					<span class="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
						owner
					</span>
				{/if}
				{#if u.status === 'pending'}
					<span
						class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
					>
						pending
					</span>
				{/if}
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{u.email}
				<Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
					{u.role}
				</Badge>
			</p>
		</div>

		{#if canManage}
			<div class="flex flex-wrap items-center gap-2">
				<form method="POST" action="?/setRole" use:enhance={toastErrors()}>
					<input type="hidden" name="userId" value={u.id} />
					<input type="hidden" name="role" value={u.role === 'admin' ? 'member' : 'admin'} />
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={u.role === 'admin' && (isSelf || u.isOwner)}
						title={u.role === 'admin' && u.isOwner ? 'Remove owner status first' : undefined}
					>
						{u.role === 'admin' ? 'Make member' : 'Make admin'}
					</Button>
				</form>
				<form method="POST" action="?/setStatus" use:enhance={toastErrors()}>
					<input type="hidden" name="userId" value={u.id} />
					<input
						type="hidden"
						name="status"
						value={u.status === 'pending' ? 'active' : 'pending'}
					/>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={u.status !== 'pending' && (isSelf || u.isOwner)}
					>
						{u.status === 'pending' ? 'Activate' : 'Deactivate'}
					</Button>
				</form>
				<form
					method="POST"
					action="?/deleteUser"
					use:enhance={toastErrors(
						confirmFirst(
							`Delete ${u.email}? This removes their access and tokens.`,
							() =>
								async ({ result, update }) => {
									if (result.type === 'success') await goto('/users');
									else await update();
								}
						)
					)}
				>
					<input type="hidden" name="userId" value={u.id} />
					<Button
						type="submit"
						variant="outline"
						size="sm"
						class="text-destructive hover:bg-destructive/10"
						disabled={isSelf || (u.isOwner && data.lastOwner)}
						title={isSelf
							? 'You cannot delete your own account'
							: u.isOwner && data.lastOwner
								? 'Add another owner before deleting the last one'
								: undefined}
					>
						<Trash2 class="size-4" />
						Delete
					</Button>
				</form>
			</div>
		{/if}
	</header>

	{#if form?.error}
		<p class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	{#if u.role === 'admin'}
		<p class="mb-8 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
			Admins bypass grants and hold every permission; grants below only take effect if this user is
			demoted to member.
		</p>
	{/if}

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="mb-4 text-sm font-medium">Groups</h2>
		<ul class="divide-y">
			{#each data.memberships as membership (membership.id)}
				<li class="flex items-center gap-2 py-2 text-sm">
					{#if canManage}
						<a href="/groups/{membership.id}" class="hover:underline">{membership.name}</a>
					{:else}
						<span>{membership.name}</span>
					{/if}
					{#if membership.source === 'sso'}<Badge variant="secondary">sso</Badge>{/if}
				</li>
			{:else}
				<li class="py-2 text-sm text-muted-foreground">No group memberships.</li>
			{/each}
		</ul>
	</section>

	<div class="space-y-8">
		<GrantEditor grants={data.grants} cacheNames={data.cacheNames} editable={canManage} />

		<section class="rounded-lg border bg-card p-5">
			<h2 class="mb-1 text-sm font-medium">Access via groups</h2>
			<p class="mb-4 text-sm text-muted-foreground">
				{canManage
					? "Inherited from group membership — edit these on the group's page."
					: 'Inherited from group membership.'}
			</p>
			<div class="overflow-x-auto rounded-lg border">
				<table class="w-full text-sm">
					<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
						<tr>
							<th class="px-4 py-2.5 font-medium">Cache</th>
							<th class="px-4 py-2.5 font-medium">Permissions</th>
							<th class="px-4 py-2.5 font-medium">Via group</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each data.viaGroups as grant (grant.id)}
							<tr class="transition-colors hover:bg-muted/30">
								<td class="px-4 py-2.5">
									<code class="rounded bg-muted px-1.5 py-0.5 text-xs">{grant.pattern}</code>
								</td>
								<td class="px-4 py-2.5 text-muted-foreground">
									{formatGrantActions(grant.actions)}
								</td>
								<td class="px-4 py-2.5">
									{#if canManage}
										<a href="/groups/{grant.group_id}" class="font-medium hover:underline">
											{grant.group_name}
										</a>
									{:else}
										<span class="font-medium">{grant.group_name}</span>
									{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="3" class="px-4 py-3 text-sm text-muted-foreground">
									No access inherited from groups.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="rounded-lg border bg-card p-5">
			<h2 class="mb-1 text-sm font-medium">Tokens</h2>
			<p class="mb-4 text-sm text-muted-foreground">
				Tokens are permission snapshots of the holder's grants at mint time. Deactivating the
				account suspends its tokens (they resume on reactivation); revoking is permanent.
			</p>
			<TokenTable
				tokens={data.tokens}
				revokeAction="?/revokeToken"
				emptyText="No tokens issued by this user."
			/>
		</section>
	</div>
</div>
