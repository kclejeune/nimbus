<script lang="ts" generics="T extends string">
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';

	let {
		options,
		value,
		onpick,
		label
	}: {
		options: [T, string][];
		value: T;
		onpick: (v: T) => void;
		label: string;
	} = $props();
</script>

<!-- One segmented control for every small either/or toggle. Single-select
     toggle groups deselect on a second click; ignore the resulting empty value
     so one option is always active. -->
<ToggleGroup.Root
	type="single"
	{value}
	onValueChange={(v) => v && onpick(v as T)}
	variant="outline"
	size="sm"
	aria-label={label}
	class="bg-background shadow-(--shadow-panel)"
>
	{#each options as [val, text] (val)}
		<ToggleGroup.Item value={val} class="!px-3 text-xs">{text}</ToggleGroup.Item>
	{/each}
</ToggleGroup.Root>
