<script lang="ts">
	import { goto } from '$app/navigation';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import PerformanceView from './performance-view.svelte';
	import StorageView from './storage-view.svelte';

	let { data } = $props();

	const tabs = [
		{ key: 'performance', label: 'Performance', href: '?' },
		{ key: 'storage', label: 'Storage', href: '?view=storage' }
	] as const;

	function pickWindow(key: string) {
		const params = new URLSearchParams();
		if (key !== '24h') params.set('window', key);
		goto(params.size ? `?${params}` : '?', { replaceState: true, noScroll: true, keepFocus: true });
	}
</script>

<Page>
	<PageHeader
		title="Usage"
		description="How the cache is performing and what it stores, across every cache on this instance."
		class="mb-5"
	>
		{#snippet actions()}
			{#if data.view === 'performance'}
				<!-- One time filter, scoping every chart below it. -->
				<label class="sr-only" for="window">Time window</label>
				<select
					id="window"
					class="native-select w-40"
					value={data.window}
					onchange={(e) => pickWindow(e.currentTarget.value)}
				>
					{#each data.windows as w (w.key)}
						<option value={w.key}>{w.label}</option>
					{/each}
				</select>
			{/if}
		{/snippet}
	</PageHeader>

	<nav aria-label="Usage views" class="mb-8 border-b">
		<ul class="-mb-px flex sm:gap-1">
			{#each tabs as tab (tab.key)}
				{@const active = data.view === tab.key}
				<li>
					<a
						href={tab.href}
						aria-current={active ? 'page' : undefined}
						data-sveltekit-noscroll
						class="inline-flex h-10 items-center border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3 {active
							? 'border-primary text-foreground'
							: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
					>
						{tab.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	{#if data.view === 'performance'}
		<PerformanceView result={data.observability} />
	{:else}
		<StorageView storage={data.storage} />
	{/if}
</Page>
