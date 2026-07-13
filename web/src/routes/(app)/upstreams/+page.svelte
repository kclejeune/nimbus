<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Check, Plus, Trash2 } from '@lucide/svelte';

	let { data, form } = $props();
	let adding = $state(false);
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Upstream caches</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			The server-wide trust registry: one entry per upstream URL with its signing key and TTL.
			Caches choose how they use each entry (off / redirect / persist) on their own settings page;
			enforced entries apply to every cache and cannot be turned off. With a public key set, an
			upstream path only counts as present when its narinfo carries a valid signature from that key.
		</p>
	</header>

	<div class="space-y-4">
		{#each data.upstreams as upstream (upstream.id)}
			<form
				method="POST"
				action="?/update"
				use:enhance={toastErrors()}
				class="space-y-3 rounded-lg border bg-card p-5"
			>
				<input type="hidden" name="id" value={upstream.id} />
				<div class="grid grid-cols-2 gap-3">
					<div class="space-y-1.5">
						<Label class="text-xs text-muted-foreground">URL</Label>
						<Input
							name="url"
							type="url"
							value={upstream.url}
							autocomplete="off"
							class="font-mono text-xs"
						/>
					</div>
					<div class="space-y-1.5">
						<Label class="text-xs text-muted-foreground">Public key</Label>
						<Input
							name="public_key"
							value={upstream.publicKey ?? ''}
							placeholder="name:base64… (optional)"
							autocomplete="off"
							class="font-mono text-xs"
						/>
					</div>
				</div>
				<div class="flex flex-wrap items-end gap-4">
					<div class="w-28 space-y-1.5">
						<Label class="text-xs text-muted-foreground">TTL (hours)</Label>
						<Input
							name="ttl_hours"
							type="number"
							min="1"
							max="8760"
							placeholder="168"
							value={upstream.ttlHours}
							class="h-8 text-xs"
						/>
					</div>
					<div class="w-40 space-y-1.5">
						<Label class="text-xs text-muted-foreground">Default mode</Label>
						<select
							name="default_mode"
							value={upstream.defaultMode}
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
							checked={upstream.enforced}
							class="size-4 rounded border-input text-primary"
						/>
						Enforced
					</label>
					<div class="flex-1 text-right text-xs text-muted-foreground">
						used by {upstream.usage.redirect + upstream.usage.persist}
						{upstream.usage.redirect + upstream.usage.persist === 1 ? 'cache' : 'caches'}
						{#if upstream.usage.persist > 0}({upstream.usage.persist} persist){/if}
					</div>
					<Button type="submit" variant="secondary" size="sm">Save</Button>
					<Button
						type="submit"
						variant="ghost"
						size="icon"
						formaction="?/remove"
						aria-label="Remove upstream"
						onclick={(e: MouseEvent) => {
							if (!confirm(`Remove upstream ${upstream.url}? Cached verdicts are dropped.`)) {
								e.preventDefault();
							}
						}}
					>
						<Trash2 class="size-4" />
					</Button>
				</div>
			</form>
		{:else}
			<p class="text-sm text-muted-foreground">No upstreams registered.</p>
		{/each}
	</div>

	{#if form?.error}
		<p class="mt-4 text-sm text-destructive">{form.error}</p>
	{/if}
	{#if form?.saved}
		<p class="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
			<Check class="size-4" /> Saved
		</p>
	{/if}

	<hr class="my-8 border-border" />

	<section class="rounded-lg border border-dashed p-5">
		<h2 class="text-sm font-medium">Add upstream</h2>
		<form
			method="POST"
			action="?/add"
			use:enhance={toastErrors(() => {
				adding = true;
				return async ({ update }) => {
					await update();
					adding = false;
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
						placeholder="name:base64… (optional)"
						autocomplete="off"
						class="font-mono text-xs"
					/>
				</div>
			</div>
			<div class="flex flex-wrap items-end gap-4">
				<div class="w-28 space-y-1.5">
					<Label for="new_ttl" class="text-xs text-muted-foreground">TTL (hours)</Label>
					<Input
						id="new_ttl"
						name="ttl_hours"
						type="number"
						min="1"
						max="8760"
						placeholder="168"
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
					<input name="enforced" type="checkbox" class="size-4 rounded border-input text-primary" />
					Enforced
				</label>
				<Button type="submit" variant="outline" disabled={adding}>
					<Plus class="size-4" />
					{adding ? 'Adding…' : 'Add upstream'}
				</Button>
			</div>
		</form>
		<p class="mt-3 text-xs text-muted-foreground">
			TTL bounds how long a hit is served before the upstream is re-checked (default 168h) and
			doubles as the query order: longer-lived upstreams are tried first, so give stable archives
			like cache.nixos.org a long TTL and caches that garbage-collect a short one. Changing a URL or
			key wipes that upstream's cached verdicts so everything re-probes under the new identity.
		</p>
	</section>
</div>
