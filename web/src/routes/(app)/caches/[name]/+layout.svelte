<script lang="ts">
	import { page } from '$app/state';
	import { formatBytes } from '$lib/format';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import TabNav from '$lib/components/layout/tab-nav.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import { Globe, Lock } from '@lucide/svelte';

	let { data, children } = $props();
	const c = $derived(data.cacheHeader);
	const base = $derived(`/caches/${encodeURIComponent(c.name)}`);

	const tabs = $derived(
		[
			{ label: 'Paths', href: base, route: '/(app)/caches/[name]' },
			{ label: 'Connect', href: `${base}/connect`, route: '/(app)/caches/[name]/connect' },
			...(data.cacheViewer.canManage
				? [
						{ label: 'Pins', href: `${base}/pins`, route: '/(app)/caches/[name]/pins' },
						{ label: 'Access', href: `${base}/access`, route: '/(app)/caches/[name]/access' },
						{ label: 'Settings', href: `${base}/settings`, route: '/(app)/caches/[name]/settings' }
					]
				: [])
		].map((t) => ({ ...t, active: t.route === page.route.id }))
	);
	// A store path's detail page is a drill-down with its own header, not a tab.
	const isTab = $derived(tabs.some((t) => t.active));
</script>

{#if isTab}
	<Page>
		<PageHeader title={c.name} mono class="mb-5">
			{#snippet meta()}
				{#if c.isPublic}
					<StatusBadge tone="primary"><Globe class="size-3" /> Public</StatusBadge>
				{:else}
					<StatusBadge><Lock class="size-3" /> Private</StatusBadge>
				{/if}
				<span>Priority <span class="font-mono text-foreground">{c.priority}</span></span>
				<span>Compression <span class="font-mono text-foreground">{c.compression}</span></span>
				<span>
					Retention
					<span class="text-foreground"
						>{c.retentionDays ? `${c.retentionDays} days` : 'forever'}</span
					>
				</span>
				{#if c.retentionMaxBytes}
					<span>
						Size limit
						<span class="font-mono text-foreground">{formatBytes(c.retentionMaxBytes)}</span>
					</span>
				{/if}
			{/snippet}
		</PageHeader>

		<TabNav label="Cache sections" {tabs} />

		{@render children()}
	</Page>
{:else}
	{@render children()}
{/if}
