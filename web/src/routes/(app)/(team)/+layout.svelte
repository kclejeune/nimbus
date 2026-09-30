<script lang="ts">
	import { page } from '$app/state';
	import { plural } from '$lib/format';
	import { samePath } from '$lib/nav';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import TabNav from '$lib/components/layout/tab-nav.svelte';

	let { data, children } = $props();

	const tabs = $derived(
		[
			{
				label: 'People',
				href: '/users',
				badge: data.pendingUsers,
				badgeTitle: plural(data.pendingUsers, 'pending user')
			},
			{ label: 'Groups', href: '/groups' }
		].map((t) => ({ ...t, active: samePath(t.href, page.url.pathname) }))
	);
	// A person's or group's own page is a drill-down with its own header.
	const isTab = $derived(tabs.some((t) => t.active));
</script>

{#if isTab}
	<Page>
		<PageHeader
			title="Team"
			description="Users and the groups that grant them cache access."
			class="mb-5"
		/>
		<TabNav label="Team sections" {tabs} />
		{@render children()}
	</Page>
{:else}
	{@render children()}
{/if}
