<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import GrantEditor from '$lib/components/grant-editor.svelte';
	import { Plus, Trash2 } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

	let { data, form } = $props();

	const nonMembers = $derived(
		data.allUsers.filter((u) => !data.members.some((m) => m.id === u.id))
	);
</script>

<Page>
	<PageHeader title={data.group.name} description={data.group.description || undefined}>
		{#snippet meta()}
			<span class="tabular-nums">
				{data.members.length}
				{data.members.length === 1 ? 'member' : 'members'}
			</span>
			{#if data.group.oidcGroup}
				<span>
					Synced from
					<code
						class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs text-foreground"
						>{data.group.oidcGroup}</code
					>
				</span>
			{/if}
		{/snippet}
	</PageHeader>

	{#if form?.error}
		<p role="alert" class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	<div class="grid grid-cols-1 gap-6">
		<Panel title="Members" flush>
			{#if data.members.length === 0}
				<p class="px-5 py-6 text-center text-sm text-muted-foreground">No members yet.</p>
			{:else}
				<ul class="divide-y">
					{#each data.members as member (member.id)}
						<li class="flex items-center gap-3 px-5 py-2.5">
							<span
								aria-hidden="true"
								class="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
							>
								{(member.name || member.email || '?').slice(0, 1).toUpperCase()}
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2 text-sm">
									<a href="/users/{member.id}" class="row-link">{member.name}</a>
									{#if member.source === 'sso'}
										<StatusBadge title="Membership synced from the SSO groups claim"
											>Synced from SSO</StatusBadge
										>
									{/if}
								</div>
								<div class="truncate text-xs text-muted-foreground">{member.email}</div>
							</div>
							<form method="POST" action="?/removeMember" use:enhance={toastErrors()}>
								<input type="hidden" name="user_id" value={member.id} />
								<Button
									type="submit"
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
									aria-label="Remove {member.name} from group"
								>
									<Trash2 />
								</Button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
			<form
				method="POST"
				action="?/addMember"
				use:enhance={toastErrors()}
				class="flex flex-wrap items-end gap-3 border-t bg-subtle px-5 py-4"
			>
				<div class="space-y-2">
					<Label for="user_id">Add a member</Label>
					<select id="user_id" name="user_id" class="native-select w-72 max-w-full">
						{#each nonMembers as user (user.id)}
							<option value={user.id}>{user.name} ({user.email})</option>
						{/each}
					</select>
				</div>
				<Button type="submit" disabled={nonMembers.length === 0}><Plus /> Add member</Button>
			</form>
		</Panel>

		<GrantEditor grants={data.grants} cacheNames={data.cacheNames} />

		<Panel
			title="SSO group sync"
			description="Set a groups-claim value to sync membership from your identity provider at every sign-in. Members added by hand are never removed by sync."
		>
			<form
				method="POST"
				action="?/setMapping"
				use:enhance={toastErrors()}
				class="flex flex-wrap items-end gap-3"
			>
				<div class="space-y-2">
					<Label for="oidc_group">Claim value</Label>
					<Input
						id="oidc_group"
						name="oidc_group"
						value={data.group.oidcGroup ?? ''}
						placeholder="developers"
						class="w-64 max-w-full font-mono"
					/>
				</div>
				<Button type="submit" variant="outline">Save mapping</Button>
			</form>
		</Panel>
	</div>
</Page>
