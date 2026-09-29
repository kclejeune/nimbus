<script lang="ts">
	export interface Tab {
		label: string;
		href: string;
		active: boolean;
		/** A count shown beside the label (hidden when 0). */
		badge?: number;
		badgeTitle?: string;
	}

	let { label, tabs }: { label: string; tabs: Tab[] } = $props();
</script>

<!-- Underlined page-level tabs (Team, a cache, Usage). Tabs are links, so each
     is its own URL; noscroll keeps the header in place while switching. -->
<nav aria-label={label} class="mb-8 border-b">
	<ul class="-mb-px flex overflow-x-auto sm:gap-1">
		{#each tabs as tab (tab.href)}
			<li>
				<a
					href={tab.href}
					aria-current={tab.active ? 'page' : undefined}
					data-sveltekit-noscroll
					class="inline-flex h-10 items-center gap-2 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3 {tab.active
						? 'border-primary text-foreground'
						: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
				>
					{tab.label}
					{#if tab.badge}
						<span
							class="rounded-[5px] bg-warning/15 px-1.5 text-xs font-medium text-warning tabular-nums"
							title={tab.badgeTitle}>{tab.badge}</span
						>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
</nav>
