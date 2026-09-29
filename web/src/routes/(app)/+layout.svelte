<script lang="ts">
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import SiteHeader from '$lib/components/site-header.svelte';
	import CommandPalette from '$lib/components/command-palette.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';

	let { children, data } = $props();
</script>

<Sidebar.Provider
	style="--sidebar-width: calc(var(--spacing) * 60); --header-height: calc(var(--spacing) * 12);"
>
	<AppSidebar variant="inset" user={data.user} pendingUsers={data.pendingUsers} />
	<Sidebar.Inset>
		<SiteHeader />
		<!-- Plain block (not flex): flex items default to min-width auto, which
		     would let wide tables force page-level horizontal scroll instead of
		     scrolling inside their own overflow-x-auto containers. -->
		<div class="min-w-0 flex-1">
			{@render children()}
		</div>
	</Sidebar.Inset>
</Sidebar.Provider>

<CommandPalette role={data.user?.role} />
