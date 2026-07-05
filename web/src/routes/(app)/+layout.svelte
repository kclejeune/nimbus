<script lang="ts">
	import { page } from '$app/state';
	import { goto, afterNavigate } from '$app/navigation';
	import { toggleMode, mode } from 'mode-watcher';
	import { authClient } from '$lib/auth-client';
	import * as Sheet from '$lib/components/ui/sheet';
	import {
		LayoutDashboard,
		Boxes,
		KeyRound,
		Users,
		ChartLine,
		LogOut,
		Sun,
		Moon,
		Menu
	} from '@lucide/svelte';

	let { children, data } = $props();

	let sidebarOpen = $state(false);

	afterNavigate(() => {
		sidebarOpen = false;
	});

	const nav = [
		{ href: '/', label: 'Overview', icon: LayoutDashboard },
		{ href: '/caches', label: 'Caches', icon: Boxes },
		{ href: '/monitoring', label: 'Monitoring', icon: ChartLine },
		{ href: '/tokens', label: 'Tokens', icon: KeyRound },
		{ href: '/users', label: 'Users', icon: Users }
	];

	function isActive(href: string): boolean {
		return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
	}

	async function signOut() {
		await authClient.signOut();
		await goto('/login');
	}

	const user = $derived(data.user);
	const initial = $derived((user?.name ?? user?.email ?? '?').slice(0, 1).toUpperCase());
</script>

{#snippet logo(cls: string)}
	<!-- Crystalline mark: a nod to the Nix snowflake -->
	<svg viewBox="0 0 24 24" class="{cls} text-primary" aria-hidden="true">
		<path
			fill="currentColor"
			d="M12 1.5 8.5 7.5H2l3.25 5.62L2 18.75h6.5L12 24.75l3.5-6h6.5l-3.25-5.63L22 7.5h-6.5L12 1.5Zm0 4.2 1.9 3.3H10.1L12 5.7Zm-6.6 3.3h3.8L7.3 12.3 5.4 9Zm9.4 0h3.8L16.7 12.3 14.8 9Zm-4.7 3.3h3.8L12 18.6l-1.9-3.3Z"
		/>
	</svg>
{/snippet}

{#snippet sidebar()}
	<div class="flex items-center gap-2.5 px-5 py-5">
		{@render logo('size-6')}
		<span class="font-mono text-lg font-semibold tracking-tight">attic</span>
	</div>

	<nav class="flex flex-1 flex-col gap-0.5 px-3 py-2">
		{#each nav as item (item.href)}
			{@const Icon = item.icon}
			<a
				href={item.href}
				class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors
					{isActive(item.href)
					? 'bg-sidebar-accent text-sidebar-accent-foreground'
					: 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'}"
				aria-current={isActive(item.href) ? 'page' : undefined}
			>
				<Icon class="size-4" />
				{item.label}
			</a>
		{/each}
	</nav>

	<div class="border-t border-sidebar-border p-3">
		<button
			onclick={toggleMode}
			class="mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
		>
			{#if mode.current === 'dark'}
				<Sun class="size-4" /> Light mode
			{:else}
				<Moon class="size-4" /> Dark mode
			{/if}
		</button>
		<div class="flex items-center gap-2.5 px-2 py-1.5">
			<div
				class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
			>
				{initial}
			</div>
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium">{user?.name ?? user?.email ?? 'You'}</div>
				<div class="truncate text-xs text-muted-foreground">{user?.email ?? ''}</div>
			</div>
			<button
				onclick={signOut}
				title="Sign out"
				class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
			>
				<LogOut class="size-4" />
			</button>
		</div>
	</div>
{/snippet}

<div class="min-h-svh bg-background text-foreground md:grid md:grid-cols-[15rem_1fr]">
	<header
		class="sticky top-0 z-30 flex items-center gap-3 border-b border-sidebar-border bg-sidebar px-4 py-3 md:hidden"
	>
		<button
			onclick={() => (sidebarOpen = true)}
			class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
			aria-label="Open navigation"
		>
			<Menu class="size-5" />
		</button>
		{@render logo('size-5')}
		<span class="font-mono text-base font-semibold tracking-tight">attic</span>
	</header>

	<Sheet.Root bind:open={sidebarOpen}>
		<Sheet.Content side="left" class="flex w-60 flex-col gap-0 bg-sidebar p-0">
			<Sheet.Title class="sr-only">Navigation</Sheet.Title>
			{@render sidebar()}
		</Sheet.Content>
	</Sheet.Root>

	<aside class="hidden flex-col border-r border-sidebar-border bg-sidebar md:flex">
		{@render sidebar()}
	</aside>

	<main class="min-w-0 overflow-x-hidden">
		{@render children()}
	</main>
</div>
