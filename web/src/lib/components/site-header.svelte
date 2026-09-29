<script lang="ts">
	import { page } from '$app/state';
	import { mode, toggleMode } from 'mode-watcher';
	import { ChevronRight, Moon, Sun } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { breadcrumbs } from '$lib/nav';

	const crumbs = $derived(breadcrumbs(page.url.pathname, page.data));
</script>

<!-- Where you are, not what the page is called: the page's own header owns the
     title, so this bar carries the trail back up. -->
<header
	class="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 backdrop-blur-md md:rounded-t-xl"
>
	<div class="flex w-full min-w-0 items-center gap-2 px-3 lg:px-5">
		<Sidebar.Trigger class="text-muted-foreground" />
		<nav aria-label="Breadcrumb" class="min-w-0 flex-1">
			<ol class="flex min-w-0 items-center gap-1 text-sm">
				{#each crumbs as crumb, i (crumb.href)}
					{@const last = i === crumbs.length - 1}
					{#if i > 0}
						<li aria-hidden="true" class="text-muted-foreground/50">
							<ChevronRight class="size-3.5" />
						</li>
					{/if}
					<li class="min-w-0 {last ? 'truncate' : 'shrink-0'}">
						{#if last}
							<span
								aria-current="page"
								class="truncate font-medium {crumb.mono ? 'font-mono text-[0.8125rem]' : ''}"
							>
								{crumb.label}
							</span>
						{:else}
							<a
								href={crumb.href}
								class="rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground {crumb.mono
									? 'font-mono text-[0.8125rem]'
									: ''}"
							>
								{crumb.label}
							</a>
						{/if}
					</li>
				{/each}
			</ol>
		</nav>
		<Button
			variant="ghost"
			size="icon-sm"
			class="text-muted-foreground"
			onclick={toggleMode}
			title={mode.current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
		>
			{#if mode.current === 'dark'}
				<Sun />
			{:else}
				<Moon />
			{/if}
			<span class="sr-only">Toggle theme</span>
		</Button>
	</div>
</header>
