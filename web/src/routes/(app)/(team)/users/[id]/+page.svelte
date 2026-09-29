<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import GrantEditor from '$lib/components/grant-editor.svelte';
	import TokenTable from '$lib/components/token-table.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { ShieldCheck, Trash2 } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

	let { data, form } = $props();
	const u = $derived(data.subject);
	// Viewer identity comes from the (app) layout's `user`; the server guard
	// (requireSelfOrAdmin) already enforced admin-or-self.
	const isSelf = $derived(u.id === data.user.id);
	const canManage = $derived(data.user.role === 'admin');
</script>

<Page>
	<PageHeader title={u.name || u.email}>
		{#snippet meta()}
			<span>{u.email}</span>
			{#if u.role === 'admin'}
				<span class="inline-flex items-center gap-1.5 font-medium text-foreground">
					<ShieldCheck class="size-3.5 text-primary" /> Admin
				</span>
			{:else}
				<span>Member</span>
			{/if}
			{#if u.isOwner}
				<StatusBadge>Owner</StatusBadge>
			{/if}
			{#if u.status === 'pending'}
				<StatusBadge tone="warning" dot>Pending</StatusBadge>
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if canManage}
				<form method="POST" action="?/setRole" use:enhance={toastErrors()}>
					<input type="hidden" name="userId" value={u.id} />
					<input type="hidden" name="role" value={u.role === 'admin' ? 'member' : 'admin'} />
					<Button
						type="submit"
						variant="outline"
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
							{
								title: `Delete ${u.name || u.email}?`,
								description:
									'Their grants and group memberships are removed and every token they issued stops working.',
								confirmLabel: 'Delete user',
								tone: 'danger'
							},
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
						variant="destructive"
						disabled={isSelf || (u.isOwner && data.lastOwner)}
						title={isSelf
							? 'You cannot delete your own account'
							: u.isOwner && data.lastOwner
								? 'Add another owner before deleting the last one'
								: undefined}
					>
						<Trash2 />
						Delete user
					</Button>
				</form>
			{/if}
		{/snippet}
	</PageHeader>

	{#if form?.error}
		<p role="alert" class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	{#if u.role === 'admin'}
		<div
			class="mb-6 flex items-start gap-3 rounded-lg border border-primary/25 bg-accent/60 px-4 py-3 text-sm text-accent-foreground"
		>
			<ShieldCheck class="mt-0.5 size-4 shrink-0" />
			<p>
				Admins bypass grants and hold every permission. The grants below only take effect if this
				user becomes a member.
			</p>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6">
		<Panel title="Groups" flush>
			{#if data.memberships.length === 0}
				<p class="px-5 py-6 text-center text-sm text-muted-foreground">Not in any groups.</p>
			{:else}
				<ul class="divide-y">
					{#each data.memberships as membership (membership.id)}
						<li class="flex items-center gap-2 px-5 py-3 text-sm">
							{#if canManage}
								<a href="/groups/{membership.id}" class="row-link">{membership.name}</a>
							{:else}
								<span class="font-medium">{membership.name}</span>
							{/if}
							{#if membership.source === 'sso'}
								<StatusBadge title="Membership synced from the SSO groups claim"
									>Synced from SSO</StatusBadge
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		<GrantEditor grants={data.grants} cacheNames={data.cacheNames} editable={canManage} />

		<Panel
			title="Access via groups"
			description={canManage
				? "Inherited from group membership. Edit these on the group's page."
				: 'Inherited from group membership.'}
			flush
		>
			<div class="relative overflow-x-auto">
				<table class="data-table">
					<thead>
						<tr>
							<th>Cache</th>
							<th>Permissions</th>
							<th>Via group</th>
						</tr>
					</thead>
					<tbody>
						{#each data.viaGroups as grant (grant.id)}
							<tr>
								<td>
									<code class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs"
										>{grant.pattern}</code
									>
								</td>
								<td class="text-muted-foreground">
									{formatGrantActions(grant.actions)}
								</td>
								<td>
									{#if canManage}
										<a href="/groups/{grant.group_id}" class="row-link">
											{grant.group_name}
										</a>
									{:else}
										<span class="font-medium">{grant.group_name}</span>
									{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="3" class="py-6 text-center text-sm text-muted-foreground">
									No access inherited from groups.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Panel>

		<section>
			<div class="mb-3">
				<h2 class="text-base font-semibold">Tokens</h2>
				<p class="mt-0.5 max-w-2xl text-sm text-muted-foreground">
					Each token keeps the permissions its holder had when it was created. Deactivating the
					account suspends its tokens until reactivation; revoking is permanent.
				</p>
			</div>
			<TokenTable
				tokens={data.tokens}
				revokeAction="?/revokeToken"
				emptyText="This user hasn't created any tokens."
			/>
		</section>
	</div>
</Page>
