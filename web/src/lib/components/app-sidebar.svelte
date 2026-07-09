<script lang="ts">
	import { page } from '$app/state';
	import { Boxes, ChartLine, KeyRound, LayoutDashboard, Settings, Users } from '@lucide/svelte';
	import Logo from './logo.svelte';
	import NavUser from './nav-user.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import type { ComponentProps } from 'svelte';

	let {
		user,
		accessConfigured = false,
		...restProps
	}: {
		user: { name?: string | null; email?: string | null; provider?: string } | null;
		accessConfigured?: boolean;
	} & ComponentProps<typeof Sidebar.Root> = $props();

	const nav = [
		{ title: 'Overview', url: '/', icon: LayoutDashboard },
		{ title: 'Caches', url: '/caches', icon: Boxes },
		{ title: 'Monitoring', url: '/monitoring', icon: ChartLine },
		{ title: 'Tokens', url: '/tokens', icon: KeyRound },
		{ title: 'Users', url: '/users', icon: Users },
		{ title: 'Settings', url: '/settings', icon: Settings }
	];

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
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>
	<Sidebar.Footer>
		<NavUser {user} {accessConfigured} />
	</Sidebar.Footer>
</Sidebar.Root>
