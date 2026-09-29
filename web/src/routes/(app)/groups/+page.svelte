<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Plus, Trash2, UsersRound } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';

	let { data, form } = $props();
</script>

<Page>
	<PageHeader
		title="Groups"
		description="Groups collect users and carry permission grants. Map an OIDC group claim to sync membership automatically at sign-in."
	/>

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
		<EmptyState
			icon={UsersRound}
			title="No groups yet"
			description="Create a group to grant cache access to several people at once."
		/>
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
									<code class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs"
										>{group.oidcGroup}</code
									>
								{:else}
									<span class="text-muted-foreground">Managed manually</span>
								{/if}
							</td>
							<td class="!py-1 text-right">
								<form
									method="POST"
									action="?/delete"
									use:enhance={toastErrors(
										confirmFirst(
											`Delete group "${group.name}"? Its grants and memberships are removed with it.`
										)
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
</Page>
