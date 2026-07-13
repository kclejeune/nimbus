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

	let includeUpstreamUrls = $state(false);
	const nixConf = $derived(nixConfSnippet(url, publicKey, upstreams, includeUpstreamUrls));
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
			{#if upstreams.length > 0}
				<label class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						bind:checked={includeUpstreamUrls}
						class="size-3.5 rounded border-input text-primary"
					/>
					Also list upstream substituters (queried after this endpoint; redirects usually make this unnecessary)
				</label>
				<p class="mt-1 text-xs text-muted-foreground">
					Upstream signing keys are always included — redirected paths keep their upstream
					signatures.
				</p>
			{/if}
		</div>
	</Card.Content>
</Card.Root>
