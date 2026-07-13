<script lang="ts">
	import CopyField from '$lib/components/copy-field.svelte';
	import CopyBlock from '$lib/components/copy-block.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { nixConfSnippet, type UpstreamRef } from '$lib/nix-conf';

	let {
		url,
		publicKey,
		upstreams = [],
		class: className = ''
	}: {
		url: string;
		publicKey: string;
		/** Enabled upstreams: their keys always ride the snippet (redirected
		 * paths keep their upstream signatures); URLs are opt-in. */
		upstreams?: UpstreamRef[];
		class?: string;
	} = $props();

	let includeKeys = $state(true);
	let includeUrls = $state(false);
	const nixConf = $derived(nixConfSnippet(url, publicKey, upstreams, { includeKeys, includeUrls }));
	// Entries flagged as Nix defaults never appear (already in every nix.conf).
	const relevant = $derived(upstreams.filter((u) => !u.nixDefault));
</script>

<Card.Root class={className}>
	<Card.Header>
		<Card.Title>Unified cache endpoint</Card.Title>
		<Card.Description>
			One substituter for every cache you can read — private caches need a pull token in netrc.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<dl class="space-y-3">
			<div>
				<dt class="mb-1 text-xs text-muted-foreground">Substituter URL</dt>
				<dd><CopyField text={url} label="Copy URL" /></dd>
			</div>
			<div>
				<dt class="mb-1 text-xs text-muted-foreground">Trusted public key</dt>
				<dd><CopyField text={publicKey} label="Copy public key" /></dd>
			</div>
		</dl>
		<div class="mt-4">
			<span class="mb-1 block text-xs text-muted-foreground">nix.conf</span>
			<CopyBlock text={nixConf} label="Copy nix.conf snippet" />
			{#if relevant.length > 0}
				<label class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						bind:checked={includeKeys}
						class="size-3.5 rounded border-input text-primary"
					/>
					Include upstream signing keys (redirected paths keep their upstream signatures)
				</label>
				<label class="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						bind:checked={includeUrls}
						class="size-3.5 rounded border-input text-primary"
					/>
					Include upstream substituters (queried after this endpoint; redirects usually make this unnecessary)
				</label>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
