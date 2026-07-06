<script lang="ts">
	import { goto } from '$app/navigation';
	import { EllipsisVertical, LogOut } from '@lucide/svelte';
	import { authClient } from '$lib/auth-client';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';

	let { user }: { user: { name?: string | null; email?: string | null } | null } = $props();

	const sidebar = Sidebar.useSidebar();
	const name = $derived(user?.name ?? user?.email ?? 'You');
	const email = $derived(user?.email ?? '');
	const initial = $derived((user?.name ?? user?.email ?? '?').slice(0, 1).toUpperCase());

	async function signOut() {
		await authClient.signOut();
		await goto('/login');
	}
</script>

<Sidebar.Menu>
	<Sidebar.MenuItem>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Sidebar.MenuButton
						{...props}
						size="lg"
						class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
					>
						<Avatar.Root class="size-8 rounded-lg">
							<Avatar.Fallback
								class="rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
							>
								{initial}
							</Avatar.Fallback>
						</Avatar.Root>
						<div class="grid flex-1 text-start text-sm leading-tight">
							<span class="truncate font-medium">{name}</span>
							<span class="truncate text-xs text-muted-foreground">{email}</span>
						</div>
						<EllipsisVertical class="ms-auto size-4" />
					</Sidebar.MenuButton>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content
				class="w-(--bits-dropdown-menu-anchor-width) min-w-56 rounded-lg"
				side={sidebar.isMobile ? 'bottom' : 'right'}
				align="end"
				sideOffset={4}
			>
				<DropdownMenu.Label class="p-0 font-normal">
					<div class="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
						<Avatar.Root class="size-8 rounded-lg">
							<Avatar.Fallback
								class="rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
							>
								{initial}
							</Avatar.Fallback>
						</Avatar.Root>
						<div class="grid flex-1 text-start text-sm leading-tight">
							<span class="truncate font-medium">{name}</span>
							<span class="truncate text-xs text-muted-foreground">{email}</span>
						</div>
					</div>
				</DropdownMenu.Label>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onclick={signOut}>
					<LogOut />
					Sign out
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</Sidebar.MenuItem>
</Sidebar.Menu>
