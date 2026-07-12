<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import GrantEditor from '$lib/components/grant-editor.svelte';
	import { Trash2 } from '@lucide/svelte';

	let { data, form } = $props();

	const nonMembers = $derived(
		data.allUsers.filter((u) => !data.members.some((m) => m.id === u.id))
	);
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">{data.group.name}</h1>
		{#if data.group.description}
			<p class="mt-1 text-sm text-muted-foreground">{data.group.description}</p>
		{/if}
	</header>

	{#if form?.error}
		<p class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="mb-1 text-sm font-medium">OIDC mapping</h2>
		<p class="mb-4 text-sm text-muted-foreground">
			When set, membership syncs from this IdP group-claim value at every login. Manually added
			members are never removed by sync.
		</p>
		<form method="POST" action="?/setMapping" use:enhance class="flex items-end gap-4">
			<div class="space-y-2">
				<Label for="oidc_group">Claim value</Label>
				<Input
					id="oidc_group"
					name="oidc_group"
					value={data.group.oidcGroup ?? ''}
					placeholder="developers"
				/>
			</div>
			<Button type="submit" variant="secondary">Save</Button>
		</form>
	</section>

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="mb-4 text-sm font-medium">Members</h2>
		<ul class="mb-4 divide-y">
			{#each data.members as member (member.id)}
				<li class="flex items-center justify-between py-2">
					<span class="text-sm">
						{member.name}
						<span class="text-muted-foreground">({member.email})</span>
						{#if member.source === 'sso'}
							<Badge variant="secondary">sso</Badge>
						{/if}
					</span>
					<form method="POST" action="?/removeMember" use:enhance>
						<input type="hidden" name="user_id" value={member.id} />
						<Button type="submit" variant="ghost" size="icon" aria-label="Remove member">
							<Trash2 class="size-4" />
						</Button>
					</form>
				</li>
			{:else}
				<li class="py-2 text-sm text-muted-foreground">No members.</li>
			{/each}
		</ul>
		<form method="POST" action="?/addMember" use:enhance class="flex items-end gap-4">
			<div class="space-y-2">
				<Label for="user_id">Add member</Label>
				<select
					id="user_id"
					name="user_id"
					class="flex h-9 w-64 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
				>
					{#each nonMembers as user (user.id)}
						<option value={user.id}>{user.name} ({user.email})</option>
					{/each}
				</select>
			</div>
			<Button type="submit" variant="secondary" disabled={nonMembers.length === 0}>Add</Button>
		</form>
	</section>

	<GrantEditor grants={data.grants} />
</div>
