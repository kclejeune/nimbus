<script lang="ts">
	import { replaceQuery } from '$lib/url-state';
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
		replaceQuery(params);
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
	{#if data.view === 'storage' && data.storage?.dataUnavailable}<p
			role="status"
			class="my-4 rounded-lg border border-warning/30 p-3 text-sm text-warning"
		>
			Some display data could not be refreshed. Recent values are shown where available; other
			details are unavailable. Retry shortly.
		</p>{/if}

	{#if data.view === 'performance'}
		<PerformanceView result={data.observability} />
	{:else}
		<StorageView storage={data.storage} />
	{/if}
</Page>
