<script lang="ts">
	import { goto } from '$app/navigation';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import TabNav from '$lib/components/layout/tab-nav.svelte';
	import PerformanceView from './performance-view.svelte';
	import StorageView from './storage-view.svelte';

	let { data } = $props();

	const tabs = $derived([
		{ label: 'Performance', href: '?', active: data.view === 'performance' },
		{ label: 'Storage', href: '?view=storage', active: data.view === 'storage' }
	]);

	function pickWindow(key: string) {
		const params = new URLSearchParams();
		if (key !== '24h') params.set('window', key);
		goto(params.size ? `?${params}` : '?', { replaceState: true, noScroll: true, keepFocus: true });
	}
</script>

<Page>
	<PageHeader title="Usage" class="mb-5">
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

	<TabNav label="Usage views" {tabs} />

	{#if data.view === 'performance'}
		<PerformanceView result={data.observability} />
	{:else}
		<StorageView storage={data.storage} />
	{/if}
</Page>
