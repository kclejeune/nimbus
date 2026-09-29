<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { gibInputValue } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Check, Globe, Lock, Trash2 } from '@lucide/svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

	let { data, form } = $props();
	const c = $derived(data.cache);
	// Destroy-only (cd) holders can view but not save configuration.
	const canConfigure = $derived(data.permissions.canConfigure);
	let submitting = $state(false);
	let renaming = $state(false);
	let deleting = $state(false);

	const maxGib = $derived(gibInputValue(c.retentionMaxBytes));
</script>

<div class="max-w-3xl">
	<p class="mb-6 text-sm text-muted-foreground">
		Changing compression only affects paths pushed afterwards.
	</p>

	<form
		method="POST"
		action="?/save"
		use:enhance={toastErrors(() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		})}
		class="space-y-6"
	>
		<Panel title="General">
			<div class="space-y-5">
				<fieldset>
					<legend class="mb-2 text-sm font-medium">
						Visibility
						{#if !data.isAdmin}
							<span class="font-normal text-muted-foreground">(admins only)</span>
						{/if}
					</legend>
					<label
						class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-checked:border-primary/50 has-checked:bg-accent/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-60"
					>
						<input
							id="is_public"
							name="is_public"
							type="checkbox"
							checked={c.isPublic}
							disabled={!canConfigure || !data.isAdmin}
							class="mt-0.5 size-4 rounded border-input text-primary focus:ring-0 focus:ring-offset-0"
						/>
						<span>
							<span class="flex items-center gap-1.5 text-sm font-medium">
								{#if c.isPublic}<Globe class="size-3.5" />{:else}<Lock class="size-3.5" />{/if}
								Public
							</span>
							<span class="mt-0.5 block text-xs text-muted-foreground">
								Anyone can pull without a token. Pushing still needs one.
							</span>
						</span>
					</label>
					{#if !data.isAdmin}
						<!-- Disabled checkboxes don't submit; preserve the current value. -->
						{#if c.isPublic}<input type="hidden" name="is_public" value="on" />{/if}
					{/if}
				</fieldset>

				<div class="grid gap-4 sm:grid-cols-2">
					<div class="space-y-2">
						<Label for="priority">Priority</Label>
						<Input
							id="priority"
							name="priority"
							type="number"
							value={c.priority}
							disabled={!canConfigure}
						/>
					</div>
					<div class="space-y-2">
						<Label for="compression">Compression</Label>
						<select
							id="compression"
							name="compression"
							value={c.compression}
							disabled={!canConfigure}
							class="native-select"
						>
							<option value="zstd">zstd</option>
							<option value="gzip">gzip</option>
							<option value="none">none</option>
						</select>
					</div>
				</div>
			</div>
		</Panel>

		<Panel
			title="Retention"
			description="Closure-aware: a path survives while anything recently pulled, or pinned, still depends on it. Over the size limit, the least recently used closures go first. Space is reclaimed by the nightly garbage collection, or right after a push tips the cache over its limit."
		>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-2">
					<Label for="retention_period">Max age (days)</Label>
					<Input
						id="retention_period"
						name="retention_period"
						type="number"
						placeholder="No expiry"
						value={c.retentionDays ?? ''}
						disabled={!canConfigure}
					/>
				</div>
				<div class="space-y-2">
					<Label for="retention_max_gib">Size limit (GiB)</Label>
					<Input
						id="retention_max_gib"
						name="retention_max_gib"
						type="number"
						step="0.1"
						min="0"
						placeholder="No limit"
						value={maxGib}
						disabled={!canConfigure}
					/>
				</div>
			</div>
		</Panel>

		<Panel title="Upstream caches" flush>
			{#snippet description()}
				Paths already available from an enabled upstream are skipped at push time and served through
				this cache on pull. Persist copies each hit into this cache in the background, re-signed and
				safe from upstream garbage collection. Upstream trust is server-wide{#if data.isAdmin};
					manage it in <a
						href="/upstreams"
						class="font-medium text-foreground underline-offset-4 hover:underline">Upstreams</a
					>{/if}.
			{/snippet}
			{#if c.upstreams.length > 0}
				<ul class="divide-y">
					{#each c.upstreams as upstream (upstream.id)}
						<li class="flex flex-wrap items-center gap-3 px-5 py-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate font-mono text-[0.8125rem]">{upstream.url}</span>
									{#if upstream.enforced}
										<StatusBadge tone="warning" title="Enforced upstreams can't be turned off">
											Enforced
										</StatusBadge>
									{/if}
								</div>
								<div class="mt-0.5 text-xs text-muted-foreground">
									{upstream.keyName ? `Signed by ${upstream.keyName}` : 'No signature check'}, TTL
									<span class="font-mono">{upstream.ttl}</span>
								</div>
							</div>
							<select
								name="upstream_mode_{upstream.id}"
								value={upstream.mode}
								disabled={!canConfigure}
								class="native-select w-48"
								aria-label="Mode for {upstream.url}"
							>
								<option value="inherit">Default ({upstream.defaultMode})</option>
								<option value="off" disabled={upstream.enforced}>Off</option>
								<option value="redirect">Redirect</option>
								<option value="persist" disabled={!data.isAdmin}>
									Persist into this cache{data.isAdmin ? '' : ' (admins only)'}
								</option>
							</select>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="px-5 py-6 text-sm text-muted-foreground">
					No upstreams are registered on this server.
				</p>
			{/if}
		</Panel>

		{#if form?.error}
			<p role="alert" class="text-sm text-destructive">{form.error}</p>
		{/if}

		<div
			class="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border bg-card/95 px-4 py-3 shadow-(--shadow-sheet) backdrop-blur"
		>
			<span class="text-sm text-muted-foreground">
				{#if form?.saved}
					<span class="inline-flex items-center gap-1.5 text-success">
						<Check class="size-4" /> Saved
					</span>
				{:else}
					General, retention and upstream settings save together.
				{/if}
			</span>
			<Button type="submit" class="ms-auto" disabled={submitting || !canConfigure}>
				{submitting ? 'Saving…' : 'Save changes'}
			</Button>
		</div>
	</form>

	<div class="mt-10 space-y-6">
		{#if canConfigure}
			<Panel
				title="Rename cache"
				description="The signing key is kept, so paths already pushed stay trusted. The substituter URL changes to the new name."
			>
				<form
					method="POST"
					action="?/rename"
					use:enhance={toastErrors(() => {
						renaming = true;
						return async ({ update }) => {
							await update({ reset: false });
							renaming = false;
						};
					})}
					class="flex flex-wrap items-end gap-3"
				>
					<div class="min-w-56 flex-1 space-y-2">
						<Label for="new_name">New name</Label>
						<Input
							id="new_name"
							name="new_name"
							value={c.name}
							autocomplete="off"
							class="font-mono"
						/>
					</div>
					<Button type="submit" variant="outline" disabled={renaming}>
						{renaming ? 'Renaming…' : 'Rename cache'}
					</Button>
				</form>
				{#if form?.renameError}
					<p role="alert" class="mt-3 text-sm text-destructive">{form.renameError}</p>
				{/if}
			</Panel>
		{/if}

		{#if data.permissions.canDestroy}
			<Panel
				title="Delete cache"
				tone="danger"
				description="Removes the cache and hides its paths. Stored data is kept, but clients can no longer pull from it."
			>
				<form
					method="POST"
					action="?/delete"
					use:enhance={toastErrors(
						confirmFirst(
							{
								title: `Delete ${c.name}?`,
								description:
									'Clients can no longer pull from it, its substituter URL stops working, and its access grants are removed. Stored data is kept until garbage collection.',
								confirmLabel: 'Delete cache',
								tone: 'danger',
								typeToConfirm: c.name
							},
							() => {
								deleting = true;
								return async ({ update }) => {
									await update();
									deleting = false;
								};
							}
						)
					)}
				>
					<Button type="submit" variant="destructive" disabled={deleting}>
						<Trash2 />
						{deleting ? 'Deleting…' : 'Delete cache'}
					</Button>
				</form>
				{#if form?.deleteError}
					<p role="alert" class="mt-3 text-sm text-destructive">{form.deleteError}</p>
				{/if}
			</Panel>
		{/if}
	</div>
</div>
