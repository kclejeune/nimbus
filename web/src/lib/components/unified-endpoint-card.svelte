<script lang="ts">
	import CopyField from '$lib/components/copy-field.svelte';
	import CopyBlock from '$lib/components/copy-block.svelte';
	import * as Card from '$lib/components/ui/card/index.js';

	let {
		url,
		publicKey,
		class: className = ''
	}: { url: string; publicKey: string; class?: string } = $props();

	const nixConf = $derived(`extra-substituters = ${url}\nextra-trusted-public-keys = ${publicKey}`);
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
		</div>
	</Card.Content>
</Card.Root>
