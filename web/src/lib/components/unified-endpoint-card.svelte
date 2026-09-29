<script lang="ts">
	import CopyField from '$lib/components/copy-field.svelte';
	import CopyBlock from '$lib/components/copy-block.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import { nixConfSnippet, type UpstreamRef } from '$lib/nix-conf';

	let {
		url,
		publicKey,
		upstreams = [],
		bare = false,
		class: className = ''
	}: {
		url: string;
		publicKey: string;
		/** Enabled upstreams: their keys always ride the snippet (redirected
		 * paths keep their upstream signatures); URLs are opt-in. */
		upstreams?: UpstreamRef[];
		/** Render just the fields, for embedding in another panel. */
		bare?: boolean;
		class?: string;
	} = $props();

	let includeKeys = $state(true);
	let includeUrls = $state(false);
	const nixConf = $derived(nixConfSnippet(url, publicKey, upstreams, { includeKeys, includeUrls }));
	// Entries flagged as Nix defaults never appear (already in every nix.conf).
	const relevant = $derived(upstreams.filter((u) => !u.nixDefault));
</script>

{#snippet body()}
	<dl class="grid gap-4 md:grid-cols-2">
		<div class="min-w-0">
			<dt class="mb-1.5 text-xs font-medium text-muted-foreground">Substituter URL</dt>
			<dd><CopyField text={url} label="Copy URL" /></dd>
		</div>
		<div class="min-w-0">
			<dt class="mb-1.5 text-xs font-medium text-muted-foreground">Trusted public key</dt>
			<dd><CopyField text={publicKey} label="Copy public key" /></dd>
		</div>
	</dl>
	<div class="mt-5">
		<span class="mb-1.5 block text-xs font-medium text-muted-foreground">nix.conf</span>
		<CopyBlock text={nixConf} label="Copy nix.conf snippet" />
		{#if relevant.length > 0}
			<div class="mt-3 space-y-1.5">
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						bind:checked={includeKeys}
						class="size-3.5 rounded border-input text-primary"
					/>
					Include upstream signing keys (needed for redirected paths)
				</label>
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						bind:checked={includeUrls}
						class="size-3.5 rounded border-input text-primary"
					/>
					Include upstream substituters (usually unnecessary)
				</label>
			</div>
		{/if}
	</div>
{/snippet}

{#if bare}
	{@render body()}
{:else}
	<Panel
		title="Unified cache endpoint"
		description="One substituter for every cache you can read. Private caches need a pull token in netrc."
		class={className}
	>
		{@render body()}
	</Panel>
{/if}
