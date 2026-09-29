<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { NAV_GROUPS, inSection } from '$lib/nav';
	import Logo from './logo.svelte';
	import NavUser from './nav-user.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import type { ComponentProps } from 'svelte';

	let {
		user,
		pendingUsers = 0,
		...restProps
	}: {
		user: {
			id?: string;
			name?: string | null;
			email?: string | null;
			provider?: string;
			role?: string;
		} | null;
		/** Count of users awaiting activation; badges the Users item for admins. */
		pendingUsers?: number;
	} & ComponentProps<typeof Sidebar.Root> = $props();

	// Groups whose every item is admin-only vanish for members, label included.
	const nav = $derived(
		NAV_GROUPS.map((group) => ({
			label: group.label,
			items: group.items
				.filter((item) => !item.adminOnly || user?.role === 'admin')
				.map((item) => ({
					...item,
					badge: item.url === '/users' ? pendingUsers : 0
				}))
		})).filter((group) => group.items.length > 0)
	);

	function isActive(item: { url: string; match?: string[] }): boolean {
		return inSection(page.url.pathname, item);
	}

	// On small screens the sidebar is a sheet overlaying the page; client-side
	// navigation doesn't unmount it, so close it whenever a link lands.
	const sidebar = Sidebar.useSidebar();
	afterNavigate(() => sidebar.setOpenMobile(false));
</script>

<Sidebar.Root collapsible="offcanvas" {...restProps}>
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					class="h-10 hover:bg-transparent data-[slot=sidebar-menu-button]:!px-1.5 [&_svg]:text-current"
				>
					{#snippet child({ props })}
						<a href="/" {...props}>
							<Logo class="!size-7" />
							<span class="text-[1.0625rem] font-semibold tracking-[-0.02em]">nimbus</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>
	<Sidebar.Content>
		{#each nav as group (group.label ?? '')}
			<Sidebar.Group>
				{#if group.label}
					<Sidebar.GroupLabel class="text-[0.75rem] font-medium text-muted-foreground/80"
						>{group.label}</Sidebar.GroupLabel
					>
				{/if}
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each group.items as item (item.url)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton tooltipContent={item.title} isActive={isActive(item)}>
									{#snippet child({ props })}
										<a href={item.url} {...props}>
											<item.icon />
											<span>{item.title}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
								{#if item.badge}
									<Sidebar.MenuBadge
										class="rounded-[5px] bg-warning/15 px-1.5 text-xs font-medium text-warning tabular-nums"
										title="{item.badge} pending {item.badge === 1 ? 'user' : 'users'}"
									>
										{item.badge}
									</Sidebar.MenuBadge>
								{/if}
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/each}
	</Sidebar.Content>
	<Sidebar.Footer>
		<NavUser {user} />
	</Sidebar.Footer>
</Sidebar.Root>
