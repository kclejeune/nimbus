<script lang="ts">
	import CopyField from '$lib/components/copy-field.svelte';
	import CopyBlock from '$lib/components/copy-block.svelte';
	import UnifiedEndpointCard from '$lib/components/unified-endpoint-card.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import { nixConfSnippet } from '$lib/nix-conf';

	let { data } = $props();
	const c = $derived(data.cache);

	let endpoint = $state<'cache' | 'unified'>('cache');
	let includeKeys = $state(true);
	let includeUrls = $state(false);
	const nixConf = $derived(
		nixConfSnippet(c.url, c.publicKey, data.upstreams, { includeKeys, includeUrls })
	);
	// Entries flagged as Nix defaults never appear (already in every nix.conf).
	const snippetUpstreams = $derived(data.upstreams.filter((u) => !u.nixDefault));

	// The CLI resolves caches against a server saved by `nimbus login`; the
	// alias here is only a suggestion, derived from the cache host.
	const alias = $derived.by(() => {
		try {
			const labels = new URL(data.cacheBase).hostname.split('.');
			return labels.find((l) => !['cache', 'app', 'www', 'nix'].includes(l)) ?? 'nimbus';
		} catch {
			return 'nimbus';
		}
	});
	const cli = $derived([
		{
			label: 'Sign in once per machine',
			command: `nimbus login ${alias} ${data.cacheBase}`
		},
		{
			label: c.isPublic
				? 'Pull from this cache (adds it to nix.conf)'
				: 'Pull from this cache (adds it to nix.conf and your token to netrc)',
			command: `nimbus use ${c.name}`
		},
		{ label: 'Push a build and its closure', command: `nimbus push ${c.name} ./result` },
		{
			label: 'Push everything a command adds to the store, once it finishes',
			command: `nimbus watch-exec ${c.name} nix build`
		}
	]);
</script>

<div class="grid gap-6">
	<Panel
		title="With the nimbus CLI"
		description="The quickest setup: the CLI writes nix.conf and netrc for you, and handles pushing."
	>
		<dl class="grid gap-4">
			{#each cli as step (step.command)}
				<div class="min-w-0">
					<dt class="mb-1.5 text-xs font-medium text-muted-foreground">{step.label}</dt>
					<dd><CopyField text={step.command} label="Copy command" /></dd>
				</div>
			{/each}
		</dl>
	</Panel>

	<Panel
		title="Configure Nix by hand"
		description={endpoint === 'cache'
			? 'Add these to nix.conf, or a flake’s nixConfig, to substitute from this cache without the CLI.'
			: 'One substituter for every cache you can read. Private caches need a pull token in netrc.'}
	>
		{#snippet actions()}
			{#if data.proxy}
				<div
					role="radiogroup"
					aria-label="Endpoint"
					class="inline-flex rounded-lg border bg-subtle p-0.5 text-sm"
				>
					{#each [['cache', 'This cache'], ['unified', 'Unified endpoint']] as [value, label] (value)}
						<button
							type="button"
							role="radio"
							aria-checked={endpoint === value}
							onclick={() => (endpoint = value as 'cache' | 'unified')}
							class="rounded-md px-2.5 py-1 font-medium transition-colors {endpoint === value
								? 'bg-background text-foreground shadow-(--shadow-sheet)'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{label}
						</button>
					{/each}
				</div>
			{/if}
		{/snippet}
		{#if endpoint === 'unified' && data.proxy}
			<UnifiedEndpointCard
				bare
				url={data.proxy.url}
				publicKey={data.proxy.publicKey}
				upstreams={data.proxy.upstreams}
			/>
		{:else}
			<dl class="grid gap-4 md:grid-cols-2">
				<div class="min-w-0">
					<dt class="mb-1.5 text-xs font-medium text-muted-foreground">Substituter URL</dt>
					<dd><CopyField text={c.url} label="Copy URL" /></dd>
				</div>
				<div class="min-w-0">
					<dt class="mb-1.5 text-xs font-medium text-muted-foreground">Trusted public key</dt>
					<dd>
						{#if c.publicKey}
							<CopyField text={c.publicKey} label="Copy public key" />
						{:else}
							<div
								class="rounded-md border bg-subtle px-3 py-2.5 font-mono text-xs text-muted-foreground"
							>
								Unavailable
							</div>
						{/if}
					</dd>
				</div>
			</dl>

			<div class="mt-5">
				<span class="mb-1.5 block text-xs font-medium text-muted-foreground">nix.conf</span>
				<CopyBlock text={nixConf} label="Copy nix.conf snippet" />
				{#if snippetUpstreams.length > 0}
					<div class="mt-3 space-y-1.5">
						<label class="flex items-center gap-2 text-xs text-muted-foreground">
							<input
								type="checkbox"
								bind:checked={includeKeys}
								class="size-3.5 rounded border-input text-primary"
							/>
							Include upstream signing keys (redirected paths keep their upstream signatures)
						</label>
						<label class="flex items-center gap-2 text-xs text-muted-foreground">
							<input
								type="checkbox"
								bind:checked={includeUrls}
								class="size-3.5 rounded border-input text-primary"
							/>
							Include upstream substituters (queried after this cache; redirects usually make this unnecessary)
						</label>
					</div>
				{/if}
			</div>
		{/if}
	</Panel>
</div>
