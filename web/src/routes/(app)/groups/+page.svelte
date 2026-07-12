<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Trash2 } from '@lucide/svelte';

	let { data, form } = $props();
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Groups</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Groups collect users and carry permission grants. Map an OIDC group claim to sync membership
			automatically at login.
		</p>
	</header>

	{#if form?.error}
		<p class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="mb-4 text-sm font-medium">Create a group</h2>
		<form method="POST" action="?/create" use:enhance class="flex flex-wrap items-end gap-4">
			<div class="space-y-2">
				<Label for="name">Name</Label>
				<Input id="name" name="name" required placeholder="developers" />
			</div>
			<div class="grow space-y-2">
				<Label for="description">Description</Label>
				<Input id="description" name="description" placeholder="optional" />
			</div>
			<Button type="submit">Create</Button>
		</form>
	</section>

	<section class="rounded-lg border bg-card">
		<ul class="divide-y">
			{#each data.groups as group (group.id)}
				<li class="flex items-center justify-between gap-4 px-5 py-4">
					<div>
						<a href="/groups/{group.id}" class="font-medium hover:underline">{group.name}</a>
						<p class="text-sm text-muted-foreground">
							{group.members}
							{group.members === 1 ? 'member' : 'members'}
							{#if group.oidcGroup}
								· synced from “{group.oidcGroup}”
							{/if}
							{#if group.description}
								· {group.description}
							{/if}
						</p>
					</div>
					<form method="POST" action="?/delete" use:enhance>
						<input type="hidden" name="id" value={group.id} />
						<Button type="submit" variant="ghost" size="icon" aria-label="Delete group">
							<Trash2 class="size-4" />
						</Button>
					</form>
				</li>
			{:else}
				<li class="px-5 py-8 text-center text-sm text-muted-foreground">No groups yet.</li>
			{/each}
		</ul>
	</section>
</div>
