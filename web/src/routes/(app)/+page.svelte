<script lang="ts">
	import { formatBytes, formatCount, formatRelativeTime } from '$lib/format';
	import UnifiedEndpointCard from '$lib/components/unified-endpoint-card.svelte';
	import CopyField from '$lib/components/copy-field.svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StorePath from '$lib/components/layout/store-path.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Check, CircleAlert, TriangleAlert, Info } from '@lucide/svelte';

	let { data } = $props();
	const s = $derived(data.stats);

	// Bytes the store would hold without NAR- and chunk-level dedup, minus what
	// it actually holds.
	const dedupBytes = $derived(Math.max(0, s.logicalBytes - s.storageBytes));
	const dedupPct = $derived(
		s.logicalBytes > 0 ? Math.round((dedupBytes / s.logicalBytes) * 100) : 0
	);
	const usagePct = $derived(
		data.globalMaxBytes ? Math.round((s.storageBytes / data.globalMaxBytes) * 100) : null
	);
	// The storage bar's scale: the global limit when one is set, else the
	// logical (pre-dedup) size so the saved share is visible against it.
	const scale = $derived(Math.max(data.globalMaxBytes ?? 0, s.logicalBytes, s.storageBytes, 1));
	const storedW = $derived((s.storageBytes / scale) * 100);
	const savedW = $derived((dedupBytes / scale) * 100);

	const facts = $derived([
		{ label: 'Caches', value: formatCount(s.caches), href: '/caches' },
		{ label: 'Store paths', value: formatCount(s.objects), href: '/paths' },
		{ label: 'Unique NARs', value: formatCount(s.nars) },
		{ label: 'Pushed before dedup', value: formatBytes(s.logicalBytes) }
	]);

	// --- Getting started: three steps, each checked against live data. ---
	const ob = $derived(data.onboarding);
	const onboarded = $derived(ob.hasCache && ob.hasToken && ob.hasPush);
	// Per-browser dismissal for people who only pull and never push; storage
	// can be unavailable (private mode), in which case it just stays visible.
	const DISMISS_KEY = 'nimbus:onboarding-dismissed';
	let dismissed = $state(false);
	$effect(() => {
		try {
			dismissed = localStorage.getItem(DISMISS_KEY) === '1';
		} catch {
			/* storage unavailable */
		}
	});
	function dismiss() {
		dismissed = true;
		try {
			localStorage.setItem(DISMISS_KEY, '1');
		} catch {
			/* storage unavailable */
		}
	}
	const endpoint = $derived(data.cacheBaseUrl ?? 'https://cache.example.com');
	// A short server alias for `nimbus login`, from the cache host: the first
	// label that isn't a generic "cache"/"app"/"www" prefix.
	const alias = $derived.by(() => {
		try {
			const labels = new URL(endpoint).hostname.split('.');
			return labels.find((l) => !['cache', 'app', 'www', 'nix'].includes(l)) ?? 'nimbus';
		} catch {
			return 'nimbus';
		}
	});
	const cacheArg = $derived(ob.firstCache ?? 'my-cache');
	const steps = $derived([
		{
			done: ob.hasCache,
			title: 'Create a cache',
			body: 'Each cache has its own substituter URL, signing key and access list. If a teammate already has one, ask them for push access instead.',
			command: null,
			href: '/caches/new',
			action: 'New cache'
		},
		{
			done: ob.hasToken,
			title: 'Sign in with the nimbus CLI',
			body: 'Opens your browser to approve the CLI, or prints a code to enter here when you’re on SSH.',
			command: `nimbus login ${alias} ${endpoint}`,
			href: null,
			action: null
		},
		{
			done: ob.hasPush,
			title: 'Push a build',
			body: 'Uploads the closure, skipping anything already cached here or upstream.',
			command: `nimbus push ${cacheArg} ./result`,
			href: null,
			action: null
		}
	]);
	const nextStep = $derived(steps.findIndex((st) => !st.done));

	const toneIcon = { warning: TriangleAlert, danger: CircleAlert, neutral: Info } as const;
	const toneClass = {
		warning: 'text-warning',
		danger: 'text-destructive',
		neutral: 'text-muted-foreground'
	} as const;
</script>

<Page>
	<PageHeader title="Overview">
		{#snippet description()}
			What needs your attention, and where storage stands across every cache{#if data.statsAt}
				{' '}
				as of the last garbage collection
				<span title={data.statsAt}>{formatRelativeTime(data.statsAt)}</span>{/if}.
		{/snippet}
	</PageHeader>

	{#if !onboarded && !dismissed}
		<section
			aria-labelledby="onboarding-heading"
			class="mb-6 overflow-hidden rounded-lg border bg-card shadow-(--shadow-panel)"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
				<h2 id="onboarding-heading" class="text-[0.9375rem] font-semibold">Get started</h2>
				<div class="flex items-center gap-3">
					<span class="text-sm text-muted-foreground tabular-nums">
						{steps.filter((st) => st.done).length} of {steps.length} done
					</span>
					<Button variant="ghost" size="sm" onclick={dismiss}>Dismiss</Button>
				</div>
			</div>
			<ol class="mt-3 divide-y border-t">
				{#each steps as step, i (step.title)}
					{@const current = i === nextStep}
					<li class="flex gap-4 px-5 py-4 {current ? 'bg-subtle' : ''}">
						<span
							class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums {step.done
								? 'bg-success/15 text-success'
								: current
									? 'bg-primary text-primary-foreground'
									: 'border text-muted-foreground'}"
						>
							{#if step.done}<Check class="size-3.5" /><span class="sr-only">Done:</span>{:else}{i +
									1}{/if}
						</span>
						<div class="min-w-0 flex-1">
							<p
								class="text-sm font-medium {step.done
									? 'text-muted-foreground line-through decoration-muted-foreground/40'
									: ''}"
							>
								{step.title}
							</p>
							{#if !step.done}
								<p class="mt-0.5 text-sm text-muted-foreground">{step.body}</p>
								{#if step.command && current}
									<CopyField class="mt-3 max-w-xl" text={step.command} label="Copy command" />
								{/if}
							{/if}
						</div>
						{#if step.href && !step.done}
							<Button size="sm" variant={current ? 'default' : 'outline'} href={step.href}
								>{step.action}</Button
							>
						{/if}
					</li>
				{/each}
			</ol>
			<p class="border-t px-5 py-3 text-xs text-muted-foreground">
				Then run <code class="font-mono">nimbus use {cacheArg}</code> on any machine that should pull
				from it.
			</p>
		</section>
	{/if}

	{#if data.attention.length > 0}
		<Panel title="Needs attention" flush class="mb-6">
			<ul class="divide-y">
				{#each data.attention as item (item.title)}
					{@const Icon = toneIcon[item.tone]}
					<li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
						<Icon class="size-4 shrink-0 {toneClass[item.tone]}" />
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium">{item.title}</p>
							<p class="text-sm text-muted-foreground">{item.detail}</p>
						</div>
						<Button variant="outline" size="sm" href={item.href}>{item.action}</Button>
					</li>
				{/each}
			</ul>
		</Panel>
	{/if}

	<!-- Storage: the number people come here for, with dedup shown as the gap
	     between what was pushed and what is actually stored. -->
	<section
		aria-labelledby="storage-heading"
		class="overflow-hidden rounded-lg border bg-card shadow-(--shadow-panel)"
	>
		<div class="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-6 pt-6">
			<div>
				<h2 id="storage-heading" class="text-sm text-muted-foreground">Storage used</h2>
				<p class="mt-1 flex items-baseline gap-2">
					<span class="text-4xl font-semibold tracking-[-0.03em] tabular-nums">
						{formatBytes(s.storageBytes)}
					</span>
					{#if data.globalMaxBytes}
						<span class="text-sm text-muted-foreground">
							of {formatBytes(data.globalMaxBytes)} limit
						</span>
					{/if}
				</p>
			</div>
			{#if dedupBytes > 0}
				<div class="sm:text-right">
					<p class="text-sm text-muted-foreground">Saved by deduplication</p>
					<p class="mt-1 text-xl font-semibold tracking-[-0.02em] tabular-nums">
						{formatBytes(dedupBytes)}
						<span class="ml-1 text-sm font-medium text-success">{dedupPct}%</span>
					</p>
				</div>
			{/if}
		</div>

		<div class="px-6 pt-5 pb-6">
			<div
				class="flex h-2.5 overflow-hidden rounded-full bg-muted"
				role="img"
				aria-label="{formatBytes(s.storageBytes)} stored, {formatBytes(
					dedupBytes
				)} saved by deduplication"
			>
				<div
					class="h-full {usagePct != null && usagePct >= 90 ? 'bg-warning' : 'bg-primary'}"
					style="width: {storedW}%"
				></div>
				{#if savedW > 0}
					<div
						class="h-full border-l-2 border-card bg-[repeating-linear-gradient(135deg,var(--success)_0_2px,transparent_2px_6px)] opacity-60"
						style="width: {savedW}%"
					></div>
				{/if}
			</div>
			<div class="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
				<span class="inline-flex items-center gap-1.5">
					<span class="size-2 rounded-sm bg-primary"></span> Stored after dedup
				</span>
				{#if savedW > 0}
					<span class="inline-flex items-center gap-1.5">
						<span
							class="size-2 rounded-sm bg-[repeating-linear-gradient(135deg,var(--success)_0_1px,transparent_1px_3px)]"
						></span>
						Shared content, stored once
					</span>
				{/if}
				{#if usagePct != null}
					<span class="ms-auto tabular-nums">{usagePct}% of global limit</span>
				{/if}
			</div>
		</div>

		<dl class="grid grid-cols-2 border-t bg-subtle md:grid-cols-4">
			{#each facts as fact, i (fact.label)}
				<div
					class="border-border px-6 py-4 {i % 2 === 1 ? 'border-l' : ''} {i >= 2
						? 'border-t md:border-t-0'
						: ''} {i === 2 ? 'md:border-l' : ''}"
				>
					<dt class="text-xs text-muted-foreground">{fact.label}</dt>
					<dd class="mt-1 text-lg font-semibold tracking-[-0.01em] tabular-nums">
						{#if fact.href}
							<a href={fact.href} class="hover:text-primary">{fact.value}</a>
						{:else}
							{fact.value}
						{/if}
					</dd>
				</div>
			{/each}
		</dl>
	</section>

	<div class="mt-8 grid grid-cols-1 gap-6">
		<Panel title="Recent pushes" flush>
			{#snippet actions()}
				<Button variant="ghost" size="sm" href="/paths">View all paths</Button>
			{/snippet}
			{#if data.recent.length === 0}
				<p class="px-5 py-8 text-center text-sm text-muted-foreground">
					Nothing pushed to a cache you can see yet.
				</p>
			{:else}
				<ul class="divide-y">
					{#each data.recent as p (`${p.cache}/${p.hash}`)}
						<li class="flex items-center gap-4 px-5 py-2.5">
							<div class="min-w-0 flex-1">
								<StorePath
									path={p.storePath}
									href="/caches/{encodeURIComponent(p.cache)}/paths/{p.hash}"
									wide
								/>
							</div>
							<a
								href="/caches/{encodeURIComponent(p.cache)}"
								class="hidden font-mono text-[0.8125rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:inline"
								>{p.cache}</a
							>
							<span class="w-20 text-right font-mono text-[0.8125rem] tabular-nums"
								>{formatBytes(p.narSize)}</span
							>
							<span
								class="w-20 text-right text-xs whitespace-nowrap text-muted-foreground"
								title={p.createdAt}>{formatRelativeTime(p.createdAt)}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		{#if data.proxyPublicKey && data.cacheBaseUrl}
			<UnifiedEndpointCard
				url={data.cacheBaseUrl}
				publicKey={data.proxyPublicKey}
				upstreams={data.proxyUpstreams}
			/>
		{/if}
	</div>
</Page>
