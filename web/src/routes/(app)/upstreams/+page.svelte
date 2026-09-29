<script lang="ts">
	import { ask } from '$lib/confirm.svelte';
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import {
		Check,
		ChevronDown,
		ChevronUp,
		CloudDownload,
		Plus,
		ShieldCheck,
		Trash2,
		X
	} from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

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
		enforced: u.enforced,
		nixDefault: u.nixDefault
	});
	// Working copy the inputs bind to (array order = query order); reset from
	// fresh data after each save.
	// svelte-ignore state_referenced_locally
	let entries = $state(data.upstreams.map(editable));

	const fingerprint = (rows: ReturnType<typeof editable>[]) =>
		JSON.stringify(
			rows.map((r) => [
				r.id,
				r.url,
				r.publicKey,
				String(r.ttl ?? ''),
				r.defaultMode,
				r.enforced,
				r.nixDefault
			])
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
	{@const used = usage ? usage.redirect + usage.persist : 0}
	<li class="px-5 py-4">
		<div class="flex items-start gap-3">
			<span
				class="mt-7 flex size-6 shrink-0 items-center justify-center rounded-md border bg-subtle font-mono text-xs text-muted-foreground tabular-nums"
				title="Query order"
			>
				{entries.indexOf(entry) + 1}
			</span>
			<div class="grid min-w-0 flex-1 gap-3 md:grid-cols-2">
				<div class="min-w-0 space-y-1.5">
					<Label class="text-xs text-muted-foreground">URL</Label>
					<Input
						name="url_{entry.id}"
						type="url"
						bind:value={entry.url}
						autocomplete="off"
						class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
					/>
				</div>
				<div class="min-w-0 space-y-1.5">
					<Label class="text-xs text-muted-foreground">Public key</Label>
					<Input
						name="public_key_{entry.id}"
						bind:value={entry.publicKey}
						placeholder="name:base64…"
						required
						autocomplete="off"
						class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
					/>
				</div>
			</div>
			<div class="flex flex-col items-center gap-0.5 pt-6 sm:flex-row">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					class="text-muted-foreground"
					disabled={idx === 0}
					aria-label="Move up"
					onclick={() => move(entry.id, -1)}
				>
					<ChevronUp />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					class="text-muted-foreground"
					disabled={idx === section.length - 1}
					aria-label="Move down"
					onclick={() => move(entry.id, 1)}
				>
					<ChevronDown />
				</Button>
				<Button
					type="submit"
					variant="ghost"
					size="icon-sm"
					formaction="?/remove"
					name="id"
					value={String(entry.id)}
					aria-label="Remove upstream"
					class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
					onclick={async (e: MouseEvent) => {
						// Hold the click, confirm, then resubmit with this button as the
						// submitter so its formaction and id value still apply.
						e.preventDefault();
						const button = e.currentTarget as HTMLButtonElement;
						const ok = await ask({
							title: `Remove ${entry.url}?`,
							description: 'Caches stop checking it. Paths already persisted from it stay.',
							confirmLabel: 'Remove upstream',
							tone: 'danger'
						});
						if (ok) button.form?.requestSubmit(button);
					}}
				>
					<Trash2 />
				</Button>
			</div>
		</div>
		<input type="hidden" name="position_{entry.id}" value={entries.indexOf(entry)} />
		<div class="mt-3 flex flex-wrap items-end gap-3 pl-9">
			<div class="w-28 space-y-1.5">
				<Label class="text-xs text-muted-foreground">TTL</Label>
				<Input
					name="ttl_{entry.id}"
					placeholder="30d"
					required
					bind:value={entry.ttl}
					autocomplete="off"
					class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
				/>
			</div>
			<div class="w-40 space-y-1.5">
				<Label class="text-xs text-muted-foreground">Default mode</Label>
				<select name="default_mode_{entry.id}" bind:value={entry.defaultMode} class="native-select">
					<option value="redirect">Redirect</option>
					<option value="persist">Persist</option>
					<option value="off">Off</option>
				</select>
			</div>
			<label class="check-chip">
				<input name="enforced_{entry.id}" type="checkbox" bind:checked={entry.enforced} />
				Enforced
			</label>
			<label
				class="check-chip"
				title="In Nix's default config. Left out of generated nix.conf snippets."
			>
				<input name="nix_default_{entry.id}" type="checkbox" bind:checked={entry.nixDefault} />
				Nix default
			</label>
			<div class="ms-auto flex h-8 items-center">
				{#if usage}
					<StatusBadge tone={used > 0 ? 'primary' : 'neutral'}>
						Used by {used}
						{used === 1 ? 'cache' : 'caches'}{#if usage.persist > 0}, {usage.persist} persisting{/if}
					</StatusBadge>
				{/if}
			</div>
		</div>
	</li>
{/snippet}

<Page>
	<PageHeader
		title="Upstream caches"
		description="Server-wide, queried top to bottom. Each cache picks its own mode in its settings."
	>
		{#snippet actions()}
			<Button variant={addOpen ? 'outline' : 'default'} onclick={() => (addOpen = !addOpen)}>
				{#if addOpen}<X /> Cancel{:else}<Plus /> Add upstream{/if}
			</Button>
		{/snippet}
	</PageHeader>

	{#if addOpen}
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
			class="mb-8"
		>
			<Panel
				title="Add upstream"
				description="A path counts as present upstream only if its narinfo is signed by this key."
			>
				<div class="space-y-4">
					<div class="grid gap-3 md:grid-cols-2">
						<div class="space-y-1.5">
							<Label for="new_url">URL</Label>
							<Input
								id="new_url"
								name="url"
								type="url"
								placeholder="https://cache.nixos.org"
								autocomplete="off"
								class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
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
								class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
							/>
						</div>
					</div>
					<div class="flex flex-wrap items-end gap-3">
						<div class="w-28 space-y-1.5">
							<Label for="new_ttl">TTL</Label>
							<Input
								id="new_ttl"
								name="ttl"
								placeholder="7d"
								autocomplete="off"
								class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
							/>
						</div>
						<div class="w-40 space-y-1.5">
							<Label for="new_mode">Default mode</Label>
							<select id="new_mode" name="default_mode" class="native-select">
								<option value="redirect">Redirect</option>
								<option value="persist">Persist</option>
								<option value="off">Off</option>
							</select>
						</div>
						<label class="check-chip">
							<input name="enforced" type="checkbox" />
							Enforced
						</label>
						<label
							class="check-chip"
							title="In Nix's default config. Left out of generated nix.conf snippets."
						>
							<input name="nix_default" type="checkbox" />
							Nix default
						</label>
					</div>
				</div>
				{#snippet footer()}
					<Button type="submit" disabled={adding} class="ml-auto">
						{adding ? 'Adding…' : 'Add upstream'}
					</Button>
				{/snippet}
			</Panel>
		</form>
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

		<div class="space-y-6">
			{#if enforcedEntries.length > 0}
				<Panel title="Enforced" description="Caches can't turn these off." flush>
					{#snippet actions()}
						<ShieldCheck class="size-4 text-primary" />
					{/snippet}
					<ul class="divide-y">
						{#each enforcedEntries as entry (entry.id)}
							{@render upstreamCard(entry, enforcedEntries)}
						{/each}
					</ul>
				</Panel>
			{/if}

			{#if optionalEntries.length > 0}
				<Panel
					title="Optional"
					description="Caches use the default mode unless they override it."
					flush
				>
					<ul class="divide-y">
						{#each optionalEntries as entry (entry.id)}
							{@render upstreamCard(entry, optionalEntries)}
						{/each}
					</ul>
				</Panel>
			{:else}
				<EmptyState
					icon={CloudDownload}
					title="No optional upstreams"
					description="Add one to skip pushing paths it already serves."
				/>
			{/if}
		</div>

		{#if entries.length > 0}
			<div
				class="sticky bottom-4 z-10 mt-6 flex items-center gap-3 rounded-lg border bg-card/95 px-4 py-3 shadow-(--shadow-sheet) backdrop-blur"
			>
				<span class="text-sm text-muted-foreground">
					{#if dirty}
						Unsaved changes
					{:else if form?.saved}
						<span class="inline-flex items-center gap-1.5 text-success">
							<Check class="size-4" /> Saved
						</span>
					{:else}
						No changes
					{/if}
				</span>
				<Button type="submit" class="ms-auto" disabled={!dirty || saving}>
					{saving ? 'Saving…' : 'Save changes'}
				</Button>
			</div>
		{/if}
	</form>

	{#if form?.error}
		<p role="alert" class="mt-4 text-sm text-destructive">{form.error}</p>
	{/if}

	<p class="mt-6 max-w-3xl text-xs leading-relaxed text-muted-foreground">
		TTL is how long a hit is served before the upstream is checked again, e.g. 90m, 720h or 30d.
		Changing a URL or key re-checks every path against it.
	</p>
</Page>
