<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Plus, Trash2, UsersRound } from '@lucide/svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';

	let { data, form } = $props();
</script>

<div>
	<p class="mb-6 max-w-2xl text-sm text-muted-foreground">
		A group's grants apply to all its members. Map an OIDC group claim to sync membership at
		sign-in.
	</p>

	{#if form?.error}
		<p role="alert" class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	<Panel title="Create a group" class="mb-8">
		<form
			method="POST"
			action="?/create"
			use:enhance={toastErrors()}
			class="flex flex-wrap items-end gap-3"
		>
			<div class="w-56 space-y-2">
				<Label for="name">Name</Label>
				<Input id="name" name="name" required placeholder="developers" />
			</div>
			<div class="min-w-56 grow space-y-2">
				<Label for="description"
					>Description <span class="font-normal text-muted-foreground">(optional)</span></Label
				>
				<Input id="description" name="description" placeholder="Who this group is for" />
			</div>
			<Button type="submit"><Plus /> Create group</Button>
		</form>
	</Panel>

	{#if data.groups.length === 0}
		<EmptyState icon={UsersRound} title="No groups yet" description="Create one above." />
	{:else}
		<div class="table-frame">
			<table class="data-table">
				<thead>
					<tr>
						<th>Group</th>
						<th class="num">Members</th>
						<th>Synced from</th>
						<th class="w-14"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.groups as group (group.id)}
						<tr>
							<td>
								<a href="/groups/{group.id}" class="row-link">{group.name}</a>
								{#if group.description}
									<p class="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
								{/if}
							</td>
							<td class="num">{group.members}</td>
							<td>
								{#if group.oidcGroup}
									<code class="code-chip">{group.oidcGroup}</code>
								{:else}
									<span class="text-muted-foreground">Managed manually</span>
								{/if}
							</td>
							<td class="!py-1 text-right">
								<form
									method="POST"
									action="?/delete"
									use:enhance={toastErrors(
										confirmFirst({
											title: `Delete ${group.name}?`,
											description:
												'Removes its grants and memberships. Members keep access from other grants and groups.',
											confirmLabel: 'Delete group',
											tone: 'danger'
										})
									)}
								>
									<input type="hidden" name="id" value={group.id} />
									<Button
										type="submit"
										variant="ghost"
										size="icon-sm"
										class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
										aria-label="Delete group {group.name}"
									>
										<Trash2 />
									</Button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
