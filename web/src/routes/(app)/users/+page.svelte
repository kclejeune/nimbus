<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ShieldCheck, MoreHorizontal, Trash2, UserPlus } from '@lucide/svelte';

	let { data, form } = $props();
	let error = $state('');
	let adding = $state(false);

	async function post(action: string, fields: Record<string, string>, failMsg: string) {
		error = '';
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		const res = await fetch(`?/${action}`, { method: 'POST', body });
		if (!res.ok) {
			error = failMsg;
			return;
		}
		await invalidateAll();
	}

	const setRole = (userId: string, role: 'admin' | 'member') =>
		post('setRole', { userId, role }, 'Failed to update role.');
	const setOwner = (userId: string, owner: boolean) =>
		post('setOwner', { userId, owner: String(owner) }, 'Failed to update owner.');

	function protectedReason(u: (typeof data.users)[number]): string | null {
		if (u.id === data.currentUserId) return 'You cannot delete your own account';
		if (u.isOwner && data.lastOwner) return 'Add another owner before deleting the last one';
		return null;
	}
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Users</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Everyone who signs in appears here. Admins can invite, manage roles, and remove users.
		</p>
	</header>

	{#if error}
		<p class="mb-4 text-sm text-destructive">{error}</p>
	{/if}

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="mb-1 text-sm font-medium">Invite a user</h2>
		<p class="mb-4 text-sm text-muted-foreground">
			Pre-assign a role by email; the account activates when they first sign in.
		</p>
		<form
			method="POST"
			action="?/addUser"
			use:enhance={() => {
				adding = true;
				return async ({ update }) => {
					await update();
					adding = false;
				};
			}}
			class="flex flex-wrap items-end gap-3"
		>
			<div class="min-w-56 flex-1 space-y-2">
				<Label for="email">Email</Label>
				<Input id="email" name="email" type="email" placeholder="teammate@example.com" />
			</div>
			<div class="space-y-2">
				<Label for="role">Role</Label>
				<select
					id="role"
					name="role"
					class="flex h-9 w-32 rounded-md border border-input bg-transparent px-3 py-1 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				>
					<option value="member">member</option>
					<option value="admin">admin</option>
				</select>
			</div>
			<Button type="submit" disabled={adding}>
				<UserPlus class="size-4" />
				{adding ? 'Adding…' : 'Add user'}
			</Button>
		</form>
		{#if form?.error}
			<p class="mt-3 text-sm text-destructive">{form.error}</p>
		{:else if form?.added}
			<p class="mt-3 text-sm text-muted-foreground">
				Invited <span class="font-mono text-foreground">{form.added}</span>.
			</p>
		{/if}
	</section>

	<div class="overflow-x-auto rounded-lg border">
		<table class="w-full text-sm">
			<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
				<tr>
					<th class="px-4 py-2.5 font-medium">User</th>
					<th class="px-4 py-2.5 font-medium">Sign-in</th>
					<th class="px-4 py-2.5 font-medium">Role</th>
					<th class="w-20 px-4 py-2.5"></th>
				</tr>
			</thead>
			<tbody class="divide-y">
				{#each data.users as u (u.id)}
					{@const locked = protectedReason(u)}
					<tr class="transition-colors hover:bg-muted/30">
						<td class="px-4 py-3">
							<div class="flex items-center gap-2">
								<a href="/users/{u.id}" class="font-medium hover:underline">{u.name}</a>
								{#if u.isOwner}
									<span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
										owner
									</span>
								{/if}
							</div>
							<div class="font-mono text-xs text-muted-foreground">{u.email}</div>
						</td>
						<td class="px-4 py-3 text-muted-foreground">{u.provider}</td>
						<td class="px-4 py-3">
							{#if u.role === 'admin'}
								<span class="inline-flex items-center gap-1.5 font-medium text-primary">
									<ShieldCheck class="size-3.5" /> Admin
								</span>
							{:else}
								<span class="text-muted-foreground">Member</span>
							{/if}
						</td>
						<td class="px-4 py-3">
							<div class="flex items-center justify-end gap-1">
								<DropdownMenu.Root>
									<DropdownMenu.Trigger
										class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
										aria-label="Change role"
									>
										<MoreHorizontal class="size-4" />
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item
											disabled={u.role === 'admin'}
											onSelect={() => setRole(u.id, 'admin')}
										>
											Make admin
										</DropdownMenu.Item>
										<DropdownMenu.Item
											disabled={u.role === 'member' || u.isOwner}
											onSelect={() => setRole(u.id, 'member')}
										>
											Make member
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										{#if u.isOwner}
											<DropdownMenu.Item
												disabled={data.lastOwner}
												onSelect={() => setOwner(u.id, false)}
											>
												Remove owner
											</DropdownMenu.Item>
										{:else}
											<DropdownMenu.Item onSelect={() => setOwner(u.id, true)}>
												Make owner
											</DropdownMenu.Item>
										{/if}
									</DropdownMenu.Content>
								</DropdownMenu.Root>

								{#if locked}
									<span
										class="inline-flex size-8 cursor-not-allowed items-center justify-center rounded-md text-muted-foreground/30"
										title={locked}
									>
										<Trash2 class="size-4" />
									</span>
								{:else}
									<form
										method="POST"
										action="?/deleteUser"
										use:enhance={({ cancel }) => {
											if (!confirm(`Delete ${u.email}? This removes their access and tokens.`)) {
												cancel();
												return;
											}
											return async ({ update }) => update();
										}}
									>
										<input type="hidden" name="userId" value={u.id} />
										<button
											type="submit"
											title="Delete user"
											aria-label="Delete user"
											class="inline-flex size-8 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10"
										>
											<Trash2 class="size-4" />
										</button>
									</form>
								{/if}
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
