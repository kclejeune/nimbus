<script lang="ts" module>
	/** Stage → color role. Fixed order, so a stage keeps its color on every row. */
	export const STAGE_STYLE: Record<string, { label: string; color: string }> = {
		auth: { label: 'Auth', color: 'var(--viz-6)' },
		store: { label: 'Store lookup', color: 'var(--viz-1)' },
		d1: { label: 'D1', color: 'var(--viz-2)' },
		r2: { label: 'R2', color: 'var(--viz-3)' },
		upstream: { label: 'Upstream', color: 'var(--viz-4)' },
		admission: { label: 'Admission', color: 'var(--viz-5)' },
		other: { label: 'Other', color: 'var(--muted-foreground)' }
	};
</script>

<script lang="ts">
	import { formatMs } from '$lib/format';

	let { stages, total }: { stages: Record<string, number>; total: number } = $props();

	// Stages overlap (a store lookup includes its own D1 time), so segments are
	// shares of their sum rather than of the mean; the title says so.
	const entries = $derived(
		Object.entries(STAGE_STYLE)
			.map(([k, s]) => ({ key: k, ...s, ms: stages[k] ?? 0 }))
			.filter((e) => e.ms > 0.05)
	);
	const sum = $derived(entries.reduce((a, e) => a + e.ms, 0));
</script>

<div
	class="flex h-2 w-full min-w-24 gap-[2px] overflow-hidden rounded-full"
	role="img"
	aria-label="Mean {formatMs(total)}: {entries
		.map((e) => `${e.label} ${formatMs(e.ms)}`)
		.join(', ')}"
	title={entries.map((e) => `${e.label}: ${formatMs(e.ms)}`).join('\n')}
>
	{#each entries as e (e.key)}
		<span
			class="h-full first:rounded-l-full last:rounded-r-full"
			style="flex: {e.ms / sum} 0 0; background: {e.color}"
		></span>
	{/each}
</div>
