<script lang="ts">
	import { page } from '$app/state';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';

	let { data, children } = $props();

	const tabs = $derived([
		{
			label: 'People',
			href: '/users',
			route: '/(app)/(team)/users',
			badge: data.pendingUsers
		},
		{ label: 'Groups', href: '/groups', route: '/(app)/(team)/groups', badge: 0 }
	]);
	// A person's or group's own page is a drill-down with its own header.
	const isTab = $derived(tabs.some((t) => t.route === page.route.id));
</script>

{#if isTab}
	<Page>
		<PageHeader
			title="Team"
			description="Everyone who can sign in, and the groups that carry their cache access."
			class="mb-5"
		/>
		<nav aria-label="Team sections" class="mb-8 border-b">
			<ul class="-mb-px flex sm:gap-1">
				{#each tabs as tab (tab.href)}
					{@const active = tab.route === page.route.id}
					<li>
						<a
							href={tab.href}
							aria-current={active ? 'page' : undefined}
							data-sveltekit-noscroll
							class="inline-flex h-10 items-center gap-2 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3 {active
								? 'border-primary text-foreground'
								: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
						>
							{tab.label}
							{#if tab.badge}
								<span
									class="rounded-[5px] bg-warning/15 px-1.5 text-xs font-medium text-warning tabular-nums"
									title="{tab.badge} pending {tab.badge === 1 ? 'user' : 'users'}">{tab.badge}</span
								>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
		{@render children()}
	</Page>
{:else}
	{@render children()}
{/if}
