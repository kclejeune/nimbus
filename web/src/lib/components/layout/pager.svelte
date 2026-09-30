<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';

	let {
		page,
		hasMore,
		href
	}: {
		/** 1-based. */
		page: number;
		hasMore: boolean;
		/** The URL of another page under the current filters. */
		href: (page: number) => string;
	} = $props();
</script>

<!-- Previous/Next for server-paged lists; an edge renders disabled rather
     than disappearing, so the pair holds its place. -->
<div class="flex items-center gap-2">
	{#if page > 1}
		<Button variant="outline" size="sm" href={href(page - 1)}>Previous</Button>
	{:else}
		<Button variant="outline" size="sm" disabled>Previous</Button>
	{/if}
	{#if hasMore}
		<Button variant="outline" size="sm" href={href(page + 1)}>Next</Button>
	{:else}
		<Button variant="outline" size="sm" disabled>Next</Button>
	{/if}
</div>
