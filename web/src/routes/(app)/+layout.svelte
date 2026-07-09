<script lang="ts">
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import SiteHeader from '$lib/components/site-header.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';

	let { children, data } = $props();
</script>

<Sidebar.Provider
	style="--sidebar-width: calc(var(--spacing) * 72); --header-height: calc(var(--spacing) * 12);"
>
	<AppSidebar variant="inset" user={data.user} accessConfigured={data.accessConfigured} />
	<Sidebar.Inset>
		<SiteHeader />
		<!-- Plain block (not flex): flex items default to min-width auto, which
		     would let wide tables force page-level horizontal scroll instead of
		     scrolling inside their own overflow-x-auto containers. -->
		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
