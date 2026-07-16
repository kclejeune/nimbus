<script lang="ts">
	import { page } from '$app/state';
	import { mode, toggleMode } from 'mode-watcher';
	import { Moon, Sun } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { sectionTitle } from '$lib/nav';

	const title = $derived(sectionTitle(page.url.pathname));
</script>

<header
	class="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)"
>
	<div class="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
		<Sidebar.Trigger class="-ms-1" />
		<Separator orientation="vertical" class="mx-2 data-[orientation=vertical]:h-4" />
		<h1 class="text-base font-medium">{title}</h1>
		<div class="ms-auto flex items-center gap-2">
			<Button
				variant="ghost"
				size="icon"
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
	</div>
</header>
