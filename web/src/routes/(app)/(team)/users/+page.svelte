<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import { ShieldCheck, MoreHorizontal, Trash2, UserPlus } from '@lucide/svelte';

	let { data, form } = $props();
	let adding = $state(false);

	// Programmatic action submit (the dropdown items aren't forms). Failures
	// surface the server's actual message as a toast, matching toastErrors().
	async function post(action: string, fields: Record<string, string>) {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		const res = await fetch(`?/${action}`, { method: 'POST', body });
		const result = deserialize(await res.text());
		if (result.type === 'failure') {
			toast.error(String(result.data?.error ?? 'Request failed'));
		} else if (result.type === 'error') {
			toast.error(result.error?.message ?? 'Request failed');
		} else {
			await invalidateAll();
		}
	}

	const setRole = (userId: string, role: 'admin' | 'member') => post('setRole', { userId, role });
	const setOwner = (userId: string, owner: boolean) =>
		post('setOwner', { userId, owner: String(owner) });
	const setStatus = (userId: string, status: 'active' | 'pending') =>
		post('setStatus', { userId, status });

	function protectedReason(u: (typeof data.users)[number]): string | null {
		if (u.id === data.currentUserId) return 'You cannot delete your own account';
		if (u.isOwner && data.lastOwner) return 'Add another owner before deleting the last one';
		return null;
	}
</script>

<div>
	<Panel
		title="Invite a user"
		description="Pre-assign a role by email. The account activates the first time they sign in."
		class="mb-8"
	>
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
				<select id="role" name="role" class="native-select w-32">
					<option value="member">Member</option>
					<option value="admin">Admin</option>
				</select>
			</div>
			<Button type="submit" disabled={adding}>
				<UserPlus />
				{adding ? 'Inviting…' : 'Invite user'}
			</Button>
		</form>
		{#if form?.error}
			<p role="alert" class="mt-3 text-sm text-destructive">{form.error}</p>
		{:else if form?.added}
			<p class="mt-3 text-sm text-muted-foreground">
				Invited <span class="font-medium text-foreground">{form.added}</span>.
			</p>
		{/if}
	</Panel>

	<div class="table-frame">
		<table class="data-table">
			<thead>
				<tr>
					<th>User</th>
					<th>Sign-in method</th>
					<th>Role</th>
					<th class="w-20"><span class="sr-only">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as u (u.id)}
					{@const locked = protectedReason(u)}
					<tr>
						<td>
							<div class="flex items-center gap-3">
								<span
									aria-hidden="true"
									class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
								>
									{(u.name || u.email || '?').slice(0, 1).toUpperCase()}
								</span>
								<div class="min-w-0">
									<div class="flex items-center gap-2">
										<a href="/users/{u.id}" class="row-link">{u.name || u.email}</a>
										{#if u.isOwner}
											<StatusBadge>Owner</StatusBadge>
										{/if}
										{#if u.status === 'pending'}
											<StatusBadge tone="warning" dot>Pending</StatusBadge>
										{/if}
									</div>
									<div class="truncate text-xs text-muted-foreground">{u.email}</div>
								</div>
							</div>
						</td>
						<td class="text-muted-foreground">{u.provider}</td>
						<td>
							{#if u.role === 'admin'}
								<span class="inline-flex items-center gap-1.5 font-medium">
									<ShieldCheck class="size-3.5 text-primary" /> Admin
								</span>
							{:else}
								<span class="text-muted-foreground">Member</span>
							{/if}
						</td>
						<td>
							<div class="flex items-center justify-end gap-1">
								<DropdownMenu.Root>
									<DropdownMenu.Trigger
										class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										aria-label="Manage user"
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
										<DropdownMenu.Separator />
										{#if u.status === 'pending'}
											<DropdownMenu.Item onSelect={() => setStatus(u.id, 'active')}>
												Activate
											</DropdownMenu.Item>
										{:else}
											<DropdownMenu.Item
												disabled={u.id === data.currentUserId || u.isOwner}
												onSelect={() => setStatus(u.id, 'pending')}
											>
												Deactivate
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
										use:enhance={toastErrors(
											confirmFirst({
												title: `Delete ${u.name || u.email}?`,
												description:
													'Their grants and group memberships are removed and every token they issued stops working.',
												confirmLabel: 'Delete user',
												tone: 'danger'
											})
										)}
									>
										<input type="hidden" name="userId" value={u.id} />
										<button
											type="submit"
											title="Delete user"
											aria-label="Delete user"
											class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
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
