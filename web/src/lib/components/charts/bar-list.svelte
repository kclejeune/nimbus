<script lang="ts">
	let {
		rows,
		format = (v: number) => String(Math.round(v)),
		mono = false,
		ariaLabel
	}: {
		rows: { label: string; value: number; detail?: string }[];
		format?: (v: number) => string;
		/** Labels are identifiers (colos, regions). */
		mono?: boolean;
		ariaLabel: string;
	} = $props();

	const max = $derived(Math.max(1, ...rows.map((r) => r.value)));
</script>

<!-- One series, so one color: the bar's length carries the value. -->
<ul class="space-y-2.5" aria-label={ariaLabel}>
	{#each rows as r (r.label)}
		<li class="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
			<span class="truncate {mono ? 'font-mono text-[0.8125rem]' : ''}">{r.label}</span>
			<span class="relative h-2 rounded-full bg-muted" aria-hidden="true">
				<span
					class="absolute inset-y-0 left-0 rounded-full"
					style="width: {Math.max(1.5, (r.value / max) * 100)}%; background: var(--viz-1)"
				></span>
			</span>
			<span class="text-right tabular-nums">
				{format(r.value)}
				{#if r.detail}<span class="ml-1.5 text-xs text-muted-foreground">{r.detail}</span>{/if}
			</span>
		</li>
	{/each}
</ul>
