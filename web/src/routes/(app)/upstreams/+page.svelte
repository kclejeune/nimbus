<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Check, ChevronDown, ChevronUp, Plus, ShieldCheck, Trash2, X } from '@lucide/svelte';

	let { data, form } = $props();
	let adding = $state(false);
	let addOpen = $state(false);
	let saving = $state(false);

	type Upstream = (typeof data.upstreams)[number];
	/** Editable working copy of one entry, normalized for dirty comparison. */
	const editable = (u: Upstream) => ({
		id: u.id,
		url: u.url,
		publicKey: u.publicKey ?? '',
		ttl: u.ttlText,
		defaultMode: u.defaultMode as string,
		enforced: u.enforced
	});
	// Working copy the inputs bind to (array order = query order); reset from
	// fresh data after each save.
	// svelte-ignore state_referenced_locally
	let entries = $state(data.upstreams.map(editable));

	const fingerprint = (rows: ReturnType<typeof editable>[]) =>
		JSON.stringify(
			rows.map((r) => [r.id, r.url, r.publicKey, String(r.ttl ?? ''), r.defaultMode, r.enforced])
		);
	const dirty = $derived(fingerprint(entries) !== fingerprint(data.upstreams.map(editable)));

	// Sections group by the SAVED enforced flag so cards don't jump between
	// sections while the checkbox is being edited.
	const savedEnforced = $derived(new Map(data.upstreams.map((u) => [u.id, u.enforced])));
	const isEnforced = (e: { id: number; enforced: boolean }) =>
		savedEnforced.get(e.id) ?? e.enforced;
	const enforcedEntries = $derived(entries.filter((e) => isEnforced(e)));
	const optionalEntries = $derived(entries.filter((e) => !isEnforced(e)));

	/** Swap with the neighboring entry in the same section; the array order is
	 * the global query order posted as position_<id>. */
	function move(id: number, dir: -1 | 1) {
		const entry = entries.find((e) => e.id === id);
		if (!entry) return;
		const section = entries.filter((e) => isEnforced(e) === isEnforced(entry));
		const neighbor = section[section.indexOf(entry) + dir];
		if (!neighbor) return;
		const a = entries.indexOf(entry);
		const b = entries.indexOf(neighbor);
		[entries[a], entries[b]] = [entries[b], entries[a]];
	}

	const usageOf = (id: number) => data.upstreams.find((u) => u.id === id)?.usage;
</script>

{#snippet upstreamCard(entry: (typeof entries)[number], section: typeof entries)}
	{@const usage = usageOf(entry.id)}
	{@const idx = section.indexOf(entry)}
	<div class="rounded-lg border bg-card p-5">
		<div class="flex items-start gap-3">
			<div class="grid flex-1 grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<Label class="text-xs text-muted-foreground">URL</Label>
					<Input
						name="url_{entry.id}"
						type="url"
						bind:value={entry.url}
						autocomplete="off"
						class="font-mono text-xs"
					/>
				</div>
				<div class="space-y-1.5">
					<Label class="text-xs text-muted-foreground">Public key</Label>
					<Input
						name="public_key_{entry.id}"
						bind:value={entry.publicKey}
						placeholder="name:base64…"
						required
						autocomplete="off"
						class="font-mono text-xs"
					/>
				</div>
			</div>
			<div class="flex items-center gap-0.5 pt-5">
				<Button
					type="button"
					variant="ghost"
					size="icon"
					disabled={idx === 0}
					aria-label="Move up (queried earlier)"
					onclick={() => move(entry.id, -1)}
				>
					<ChevronUp class="size-4" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					disabled={idx === section.length - 1}
					aria-label="Move down (queried later)"
					onclick={() => move(entry.id, 1)}
				>
					<ChevronDown class="size-4" />
				</Button>
				<Button
					type="submit"
					variant="ghost"
					size="icon"
					formaction="?/remove"
					name="id"
					value={String(entry.id)}
					aria-label="Remove upstream"
					class="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onclick={(e: MouseEvent) => {
						if (!confirm(`Remove upstream ${entry.url}? Cached verdicts are dropped.`)) {
							e.preventDefault();
						}
					}}
				>
					<Trash2 class="size-4" />
				</Button>
			</div>
		</div>
		<input type="hidden" name="position_{entry.id}" value={entries.indexOf(entry)} />
		<div class="mt-3 flex flex-wrap items-end gap-4">
			<div class="w-28 space-y-1.5">
				<Label class="text-xs text-muted-foreground">TTL</Label>
				<Input
					name="ttl_{entry.id}"
					placeholder="e.g. 30d"
					required
					bind:value={entry.ttl}
					autocomplete="off"
					class="h-8 text-xs"
				/>
			</div>
			<div class="w-40 space-y-1.5">
				<Label class="text-xs text-muted-foreground">Default mode</Label>
				<select
					name="default_mode_{entry.id}"
					bind:value={entry.defaultMode}
					class="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				>
					<option value="redirect">Redirect</option>
					<option value="persist">Persist</option>
					<option value="off">Off</option>
				</select>
			</div>
			<label class="flex h-8 items-center gap-2 text-sm">
				<input
					name="enforced_{entry.id}"
					type="checkbox"
					bind:checked={entry.enforced}
					class="size-4 rounded border-input text-primary"
				/>
				Enforced
			</label>
			<div class="flex-1 text-right text-xs text-muted-foreground">
				{#if usage}
					used by {usage.redirect + usage.persist}
					{usage.redirect + usage.persist === 1 ? 'cache' : 'caches'}
					{#if usage.persist > 0}({usage.persist} persist){/if}
				{/if}
			</div>
		</div>
	</div>
{/snippet}

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8 flex flex-wrap items-start justify-between gap-4">
		<div class="max-w-3xl">
			<h1 class="text-2xl font-semibold tracking-tight">Upstream caches</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				The server-wide trust registry: one entry per upstream URL with its signing key and TTL.
				Caches choose how they use each entry (off / redirect / persist) on their own settings page.
				Entries are queried top to bottom — reorder with the arrows.
			</p>
		</div>
		<Button onclick={() => (addOpen = !addOpen)}>
			{#if addOpen}<X class="size-4" /> Close{:else}<Plus class="size-4" /> Add upstream{/if}
		</Button>
	</header>

	{#if addOpen}
		<section class="mb-8 rounded-lg border bg-card p-5">
			<h2 class="text-sm font-medium">Add upstream</h2>
			<form
				method="POST"
				action="?/add"
				use:enhance={toastErrors(() => {
					adding = true;
					return async ({ update, result }) => {
						await update();
						adding = false;
						if (result.type === 'success') addOpen = false;
					};
				})}
				class="mt-4 space-y-3"
			>
				<div class="grid grid-cols-2 gap-3">
					<div class="space-y-1.5">
						<Label for="new_url">URL</Label>
						<Input
							id="new_url"
							name="url"
							type="url"
							placeholder="https://cache.nixos.org"
							autocomplete="off"
							class="font-mono text-xs"
						/>
					</div>
					<div class="space-y-1.5">
						<Label for="new_key">Public key</Label>
						<Input
							id="new_key"
							name="public_key"
							placeholder="name:base64…"
							required
							autocomplete="off"
							class="font-mono text-xs"
						/>
					</div>
				</div>
				<div class="flex flex-wrap items-end gap-4">
					<div class="w-28 space-y-1.5">
						<Label for="new_ttl" class="text-xs text-muted-foreground">TTL</Label>
						<Input
							id="new_ttl"
							name="ttl"
							placeholder="7d"
							autocomplete="off"
							class="h-8 text-xs"
						/>
					</div>
					<div class="w-40 space-y-1.5">
						<Label for="new_mode" class="text-xs text-muted-foreground">Default mode</Label>
						<select
							id="new_mode"
							name="default_mode"
							class="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
						>
							<option value="redirect">Redirect</option>
							<option value="persist">Persist</option>
							<option value="off">Off</option>
						</select>
					</div>
					<label class="flex h-8 items-center gap-2 text-sm">
						<input
							name="enforced"
							type="checkbox"
							class="size-4 rounded border-input text-primary"
						/>
						Enforced
					</label>
					<Button type="submit" disabled={adding}>
						<Plus class="size-4" />
						{adding ? 'Adding…' : 'Add upstream'}
					</Button>
				</div>
			</form>
		</section>
	{/if}

	<form
		method="POST"
		action="?/save"
		use:enhance={toastErrors(() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				saving = false;
				// Re-baseline the working copy on whatever the reload returned.
				entries = data.upstreams.map(editable);
			};
		})}
	>
		<!-- First submit button in tree order = the implicit-submission target:
		     Enter in any field saves instead of hitting a card's remove button. -->
		<button type="submit" class="hidden" tabindex="-1" aria-hidden="true"></button>

		{#if enforcedEntries.length > 0}
			<section class="mb-8">
				<h2 class="mb-1 inline-flex items-center gap-1.5 text-sm font-medium">
					<ShieldCheck class="size-3.5" /> Enforced
				</h2>
				<p class="mb-3 text-sm text-muted-foreground">
					Applied to every cache; caches cannot turn these off.
				</p>
				<div class="space-y-4">
					{#each enforcedEntries as entry (entry.id)}
						{@render upstreamCard(entry, enforcedEntries)}
					{/each}
				</div>
			</section>
		{/if}

		<section>
			<h2 class="mb-1 text-sm font-medium">Optional</h2>
			<p class="mb-3 text-sm text-muted-foreground">
				Available to caches at their chosen mode; the registry default applies unless a cache
				overrides it.
			</p>
			{#if optionalEntries.length > 0}
				<div class="space-y-4">
					{#each optionalEntries as entry (entry.id)}
						{@render upstreamCard(entry, optionalEntries)}
					{/each}
				</div>
			{:else}
				<p class="text-sm text-muted-foreground">
					No optional upstreams. Add one to enable push filtering and read fallback.
				</p>
			{/if}
		</section>

		{#if entries.length > 0}
			<div class="mt-6 flex items-center gap-3">
				<Button type="submit" variant={dirty ? 'default' : 'secondary'} disabled={!dirty || saving}>
					{saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
				</Button>
				{#if form?.saved && !dirty}
					<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
						<Check class="size-4" /> Saved
					</span>
				{/if}
			</div>
		{/if}
	</form>

	{#if form?.error}
		<p class="mt-4 text-sm text-destructive">{form.error}</p>
	{/if}

	<p class="mt-6 text-xs text-muted-foreground">
		With a public key set, an upstream path only counts as present when its narinfo carries a valid
		signature from that key. TTL takes durations like 3600s, 90m, 720h, 30d, or 1y and
		bounds how long a hit is served before the upstream is re-checked. Upstreams are queried in the
		order shown here. Changing a URL or key wipes that upstream's cached verdicts so everything
		re-probes under the new identity.
	</p>
</div>
