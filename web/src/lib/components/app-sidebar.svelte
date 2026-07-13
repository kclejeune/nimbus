<script lang="ts">
	import { page } from '$app/state';
	import {
		Boxes,
		ChartLine,
		CloudDownload,
		KeyRound,
		LayoutDashboard,
		Settings,
		Users,
		UsersRound
	} from '@lucide/svelte';
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

	const nav = $derived(
		[
			{ title: 'Overview', url: '/', icon: LayoutDashboard },
			{ title: 'Caches', url: '/caches', icon: Boxes },
			{ title: 'Upstreams', url: '/upstreams', icon: CloudDownload, adminOnly: true },
			{ title: 'Monitoring', url: '/monitoring', icon: ChartLine },
			{ title: 'Tokens', url: '/tokens', icon: KeyRound },
			{ title: 'Users', url: '/users', icon: Users, adminOnly: true, badge: pendingUsers },
			{ title: 'Groups', url: '/groups', icon: UsersRound, adminOnly: true },
			{ title: 'Settings', url: '/settings', icon: Settings }
		].filter((item) => !item.adminOnly || user?.role === 'admin')
	);

	function isActive(url: string): boolean {
		return url === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(url);
	}
</script>

<Sidebar.Root collapsible="offcanvas" {...restProps}>
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton class="data-[slot=sidebar-menu-button]:!p-1.5">
					{#snippet child({ props })}
						<a href="/" {...props}>
							<Logo class="!size-5 text-primary" />
							<span class="font-mono text-base font-semibold tracking-tight">nimbus</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>
	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each nav as item (item.url)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton tooltipContent={item.title} isActive={isActive(item.url)}>
								{#snippet child({ props })}
									<a href={item.url} {...props}>
										<item.icon />
										<span>{item.title}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
							{#if item.badge}
								<Sidebar.MenuBadge
									class="rounded-full bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
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
	</Sidebar.Content>
	<Sidebar.Footer>
		<NavUser {user} />
	</Sidebar.Footer>
</Sidebar.Root>
