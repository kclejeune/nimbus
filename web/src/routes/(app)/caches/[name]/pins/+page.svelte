<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { formatBytes, formatCount } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Pin, X } from '@lucide/svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

	let { data, form } = $props();
	let addingRoot = $state(false);

	type Root = (typeof data.roots)[number];
	// Named pins group their revision rows (newest first, per the load order);
	// anonymous quick pins render flat below them.
	const namedPins = $derived.by(() => {
		const groups = new Map<
			string,
			{ name: string; keepRevisions: number | null; revisions: Root[] }
		>();
		for (const root of data.roots) {
			if (!root.pinName) continue;
			let group = groups.get(root.pinName);
			if (!group) {
				group = { name: root.pinName, keepRevisions: root.keepRevisions, revisions: [] };
				groups.set(root.pinName, group);
			}
			group.revisions.push(root);
		}
		return [...groups.values()];
	});
	const anonRoots = $derived(data.roots.filter((r) => !r.pinName));
</script>

<Panel
	title="Pinned paths"
	description="Garbage collection never removes a pinned path or anything in its closure, regardless of age or size limits. You can also pin a path from the Paths tab."
	flush
>
	{#if data.roots.length === 0}
		<p class="px-5 py-6 text-sm text-muted-foreground">Nothing is pinned.</p>
	{:else}
		<ul class="divide-y">
			{#each namedPins as pin (pin.name)}
				<li class="px-5 py-3">
					<div class="flex items-center gap-3">
						<Pin class="size-3.5 text-primary" />
						<div class="min-w-0 flex-1">
							<span class="text-sm font-medium">{pin.name}</span>
							<span class="ml-1 text-xs text-muted-foreground">
								{pin.revisions.length}
								{pin.revisions.length === 1 ? 'revision' : 'revisions'}{pin.keepRevisions
									? `, keeps the last ${pin.keepRevisions}`
									: ''}
							</span>
						</div>
						<form method="POST" action="?/removeRoot" use:enhance={toastErrors()}>
							<input type="hidden" name="pin" value={pin.name} />
							<button
								type="submit"
								title="Remove pin and all revisions"
								aria-label="Remove pin {pin.name}"
								class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<X class="size-4" />
							</button>
						</form>
					</div>
					<ul class="mt-2 ml-6 space-y-1 border-l pl-3">
						{#each pin.revisions as root, i (root.hash)}
							<li class="flex flex-wrap items-center gap-x-2 text-xs">
								<span class="font-mono">{root.hash}</span>
								{#if i === 0}<StatusBadge tone="primary">Current</StatusBadge>{/if}
								<span class="text-muted-foreground">
									{#if root.inCache}
										{formatCount(root.closureObjects)}
										{root.closureObjects === 1 ? 'path' : 'paths'}, {formatBytes(root.closureBytes)}
									{:else}
										Not in this cache
									{/if}
									{root.note ? `(${root.note})` : ''}
								</span>
							</li>
						{/each}
					</ul>
				</li>
			{/each}
			{#each anonRoots as root (root.hash)}
				<li class="flex items-center gap-3 px-5 py-3">
					<Pin class="size-3.5 text-muted-foreground" />
					<div class="min-w-0 flex-1">
						<div class="truncate font-mono text-xs">{root.hash}</div>
						<div class="mt-0.5 text-xs text-muted-foreground">
							{#if root.inCache}
								Protects {formatCount(root.closureObjects)}
								{root.closureObjects === 1 ? 'path' : 'paths'} ({formatBytes(
									root.closureBytes
								)}){root.note ? `: ${root.note}` : ''}
							{:else}
								Not in this cache{root.note ? `: ${root.note}` : ''}
							{/if}
						</div>
					</div>
					<form method="POST" action="?/removeRoot" use:enhance={toastErrors()}>
						<input type="hidden" name="hash" value={root.hash} />
						<button
							type="submit"
							title="Unpin"
							aria-label="Unpin"
							class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<X class="size-4" />
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	{#snippet footer()}
		<form
			method="POST"
			action="?/addRoot"
			use:enhance={toastErrors(() => {
				addingRoot = true;
				return async ({ update }) => {
					await update();
					addingRoot = false;
				};
			})}
			class="w-full space-y-3 text-foreground"
		>
			<div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
				<div class="space-y-2">
					<Label for="root_path">Store path or hash</Label>
					<Input
						id="root_path"
						name="path"
						placeholder="/nix/store/… or 32-character hash"
						autocomplete="off"
						class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
					/>
				</div>
				<div class="space-y-2">
					<Label for="pin_name">Name</Label>
					<Input id="pin_name" name="pin_name" placeholder="v1.7" autocomplete="off" />
				</div>
			</div>
			<div class="flex flex-wrap items-end gap-3">
				<div class="w-28 space-y-2">
					<Label for="keep_revisions">Keep last</Label>
					<Input
						id="keep_revisions"
						name="keep_revisions"
						type="number"
						min="1"
						placeholder="All"
						autocomplete="off"
					/>
				</div>
				<div class="min-w-40 flex-1 space-y-2">
					<Label for="root_note">Note</Label>
					<Input id="root_note" name="note" placeholder="Optional" autocomplete="off" />
				</div>
				<Button type="submit" variant="outline" disabled={addingRoot}>
					<Pin />
					{addingRoot ? 'Pinning…' : 'Pin path'}
				</Button>
			</div>
			<p class="text-xs text-muted-foreground">
				Naming a pin gives it a revision history: pinning the same name again keeps the older
				revisions protected too, up to “Keep last”. Name and note are optional.
			</p>
			{#if form?.rootError}
				<p role="alert" class="text-sm text-destructive">{form.rootError}</p>
			{/if}
		</form>
	{/snippet}
</Panel>
