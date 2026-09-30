<script lang="ts">
	import { Check, ChevronDown } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { cn } from '$lib/utils.js';

	export interface FilterOption {
		value: string;
		label: string;
		/** Options sharing a group render under that heading. */
		group?: string;
		/** Monospace label (cache names, action ids). */
		mono?: boolean;
	}

	/** A single-choice entry above the options (e.g. "Mine", "All owners"). */
	export interface FilterPreset {
		label: string;
		active: boolean;
		onselect: () => void;
	}

	let {
		label,
		noun,
		allLabel,
		options,
		selected,
		onchange,
		presets,
		display,
		disabled = false,
		class: className
	}: {
		/** Accessible name of the trigger. */
		label: string;
		/** Plural for the trigger when several are picked ("3 caches"). */
		noun: string;
		/** Trigger text and top entry when nothing is picked. */
		allLabel: string;
		options: FilterOption[];
		selected: string[];
		onchange: (values: string[]) => void;
		/** Replaces the default "all" entry. */
		presets?: FilterPreset[];
		/** Overrides the computed trigger text. */
		display?: string;
		disabled?: boolean;
		class?: string;
	} = $props();

	const text = $derived.by(() => {
		if (display) return display;
		if (selected.length === 0) return allLabel;
		if (selected.length > 1) return `${selected.length} ${noun}`;
		return options.find((o) => o.value === selected[0])?.label ?? selected[0];
	});
	const mono = $derived(
		!display &&
			selected.length === 1 &&
			(options.find((o) => o.value === selected[0])?.mono ?? false)
	);

	// Groups in first-seen order; ungrouped options come first.
	const groups = $derived.by(() => {
		const out = new Map<string, FilterOption[]>();
		for (const o of options) out.set(o.group ?? '', [...(out.get(o.group ?? '') ?? []), o]);
		return [...out];
	});

	function toggle(value: string, on: boolean) {
		onchange(on ? [...selected, value] : selected.filter((v) => v !== value));
	}
</script>

<!-- A multi-select filter styled like the toolbar's native selects: pick any
     number of options without the menu closing between picks. -->
{#if disabled}
	<button type="button" class={cn('filter-trigger', className)} disabled aria-label={label}>
		<span class="truncate">{text}</span>
		<ChevronDown class="size-4 shrink-0 opacity-60" />
	</button>
{:else}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger class={cn('filter-trigger', className)} aria-label={label}>
			<span class={cn('truncate', mono && 'font-mono text-[0.8125rem]')}>{text}</span>
			<ChevronDown class="size-4 shrink-0 opacity-60" />
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-60">
			{#each presets ?? [{ label: allLabel, active: selected.length === 0, onselect: () => onchange([]) }] as preset (preset.label)}
				<DropdownMenu.Item onSelect={preset.onselect}>
					{preset.label}
					{#if preset.active}<Check class="ml-auto" />{/if}
				</DropdownMenu.Item>
			{/each}
			{#if options.length}
				<div class="max-h-72 overflow-y-auto">
					{#each groups as [group, items] (group)}
						<DropdownMenu.Separator />
						{#if group}
							<DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
								{group}
							</DropdownMenu.Label>
						{/if}
						{#each items as o (o.value)}
							<DropdownMenu.CheckboxItem
								closeOnSelect={false}
								checked={selected.includes(o.value)}
								onCheckedChange={(on) => toggle(o.value, on)}
							>
								<span class={cn('truncate', o.mono && 'font-mono text-[0.8125rem]')}>
									{o.label}
								</span>
							</DropdownMenu.CheckboxItem>
						{/each}
					{/each}
				</div>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}

<style>
	:global(.filter-trigger) {
		display: inline-flex;
		height: 2rem;
		max-width: 13rem;
		align-items: center;
		gap: 0.5rem;
		border-radius: var(--radius-lg);
		border: 1px solid var(--input);
		background: var(--background);
		padding: 0 0.5rem 0 0.625rem;
		font-size: 0.875rem;
		box-shadow: var(--shadow-panel);
		transition: border-color 150ms;
	}
	:global(.filter-trigger:focus-visible) {
		border-color: var(--ring);
		outline: 3px solid color-mix(in oklab, var(--ring) 50%, transparent);
	}
	:global(.filter-trigger:disabled) {
		opacity: 0.5;
	}
</style>
