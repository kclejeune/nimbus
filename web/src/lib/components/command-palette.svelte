<script lang="ts">
	import { goto } from '$app/navigation';
	import { Command, Dialog } from 'bits-ui';
	import {
		Boxes,
		CornerDownLeft,
		FolderSearch,
		Globe,
		Lock,
		Search,
		User,
		UsersRound
	} from '@lucide/svelte';
	import { NAV_GROUPS } from '$lib/nav';
	import { palette } from '$lib/command-palette.svelte';
	import StorePath from '$lib/components/layout/store-path.svelte';
	import type { SearchResults } from '$lib/search';

	let { role }: { role?: string } = $props();

	let query = $state('');
	let results = $state<SearchResults | null>(null);
	let loading = $state(false);

	const pages = $derived(
		NAV_GROUPS.flatMap((g) => g.items).filter((i) => !i.adminOnly || role === 'admin')
	);
	const q = $derived(query.trim().toLowerCase());
	const matchingPages = $derived(
		q ? pages.filter((p) => p.title.toLowerCase().includes(q)) : pages
	);

	// Debounced server search. The next keystroke cancels this one outright —
	// its timer if pending, its request if in flight — so a stale response
	// never lands and an abandoned query stops costing the server.
	$effect(() => {
		const term = query.trim();
		if (term.length < 2) {
			results = null;
			loading = false;
			return;
		}
		loading = true;
		const ctrl = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
				if (res.ok) results = (await res.json()) as SearchResults;
			} catch {
				// Aborted (a newer query owns `loading`) or offline.
			} finally {
				if (!ctrl.signal.aborted) loading = false;
			}
		}, 180);
		return () => {
			clearTimeout(timer);
			ctrl.abort();
		};
	});

	// Fresh palette each time it opens.
	$effect(() => {
		if (!palette.open) {
			query = '';
			results = null;
		}
	});

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			palette.open = !palette.open;
		}
	}

	function go(href: string) {
		palette.open = false;
		goto(href);
	}

	const hasResults = $derived(
		!!results &&
			results.caches.length + results.paths.length + results.users.length + results.groups.length >
				0
	);
	const itemClass =
		'flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm outline-none select-none data-selected:bg-accent data-selected:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
	const headingClass = 'px-2.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground';
</script>

<svelte:window {onkeydown} />

<Dialog.Root bind:open={palette.open}>
	<Dialog.Portal>
		<Dialog.Overlay
			class="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-foreground/20 backdrop-blur-[2px]"
		/>
		<Dialog.Content
			class="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-(--shadow-sheet)"
		>
			<Dialog.Title class="sr-only">Search</Dialog.Title>
			<!-- Server results are already filtered; only the page list is local. -->
			<Command.Root shouldFilter={false} loop>
				<div class="flex items-center gap-2.5 border-b px-4">
					<Search class="size-4 shrink-0 text-muted-foreground" />
					<Command.Input
						bind:value={query}
						placeholder="Search caches, store paths, people…"
						class="h-12 w-full border-0 bg-transparent px-0 text-[0.9375rem] outline-none placeholder:text-muted-foreground focus:ring-0"
					/>
					{#if loading}
						<span
							class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
						></span>
					{/if}
				</div>
				<Command.List class="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5">
					<Command.Viewport>
						{#if q.length >= 2 && !loading && !hasResults && matchingPages.length === 0}
							<p class="px-3 py-8 text-center text-sm text-muted-foreground">
								Nothing matches “{query.trim()}”.
							</p>
						{/if}

						{#if results?.caches.length}
							<Command.Group>
								<Command.GroupHeading class={headingClass}>Caches</Command.GroupHeading>
								<Command.GroupItems>
									{#each results.caches as c (c.name)}
										<Command.Item
											value="cache:{c.name}"
											class={itemClass}
											onSelect={() => go(`/caches/${encodeURIComponent(c.name)}`)}
										>
											<Boxes />
											<span class="font-mono text-[0.8125rem]">{c.name}</span>
											<span class="ms-auto">
												{#if c.isPublic}<Globe />{:else}<Lock />{/if}
											</span>
										</Command.Item>
									{/each}
								</Command.GroupItems>
							</Command.Group>
						{/if}

						{#if results?.paths.length}
							<Command.Group>
								<Command.GroupHeading class={headingClass}>Store paths</Command.GroupHeading>
								<Command.GroupItems>
									{#each results.paths as p (`${p.cache}/${p.hash}`)}
										<Command.Item
											value="path:{p.cache}/{p.hash}"
											class={itemClass}
											onSelect={() => go(`/caches/${encodeURIComponent(p.cache)}/paths/${p.hash}`)}
										>
											<FolderSearch />
											<span class="min-w-0 flex-1"><StorePath path={p.storePath} /></span>
											<span class="font-mono text-xs text-muted-foreground">{p.cache}</span>
										</Command.Item>
									{/each}
									<Command.Item
										value="path:all"
										class={itemClass}
										onSelect={() => go(`/paths?q=${encodeURIComponent(query.trim())}`)}
									>
										<Search />
										<span>Search all store paths for “{query.trim()}”</span>
									</Command.Item>
								</Command.GroupItems>
							</Command.Group>
						{/if}

						{#if results?.users.length || results?.groups.length}
							<Command.Group>
								<Command.GroupHeading class={headingClass}>People</Command.GroupHeading>
								<Command.GroupItems>
									{#each results?.users ?? [] as u (u.id)}
										<Command.Item
											value="user:{u.id}"
											class={itemClass}
											onSelect={() => go(`/users/${u.id}`)}
										>
											<User />
											<span>{u.name || u.email}</span>
											<span class="truncate text-xs text-muted-foreground">{u.email}</span>
										</Command.Item>
									{/each}
									{#each results?.groups ?? [] as g (g.id)}
										<Command.Item
											value="group:{g.id}"
											class={itemClass}
											onSelect={() => go(`/groups/${g.id}`)}
										>
											<UsersRound />
											<span>{g.name}</span>
											<span class="text-xs text-muted-foreground">Group</span>
										</Command.Item>
									{/each}
								</Command.GroupItems>
							</Command.Group>
						{/if}

						{#if matchingPages.length > 0}
							<Command.Group>
								<Command.GroupHeading class={headingClass}>Go to</Command.GroupHeading>
								<Command.GroupItems>
									{#each matchingPages as p (p.url)}
										<Command.Item value="page:{p.url}" class={itemClass} onSelect={() => go(p.url)}>
											<p.icon />
											<span>{p.title}</span>
										</Command.Item>
									{/each}
								</Command.GroupItems>
							</Command.Group>
						{/if}
					</Command.Viewport>
				</Command.List>
			</Command.Root>
			<div
				class="flex items-center gap-4 border-t bg-subtle px-4 py-2 text-xs text-muted-foreground"
			>
				<span class="inline-flex items-center gap-1.5"
					><kbd class="rounded border bg-background px-1 font-sans">↑</kbd><kbd
						class="rounded border bg-background px-1 font-sans">↓</kbd
					> to move</span
				>
				<span class="inline-flex items-center gap-1.5"
					><kbd class="rounded border bg-background px-1"><CornerDownLeft class="size-3" /></kbd> to open</span
				>
				<span class="ms-auto inline-flex items-center gap-1.5"
					><kbd class="rounded border bg-background px-1 font-sans">esc</kbd> to close</span
				>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
