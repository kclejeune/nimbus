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

	let {
		label,
		noun,
		allLabel,
		options,
		selected,
		onchange,
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
		disabled?: boolean;
		class?: string;
	} = $props();

	// A selected value missing from `options` (an id from a shared link that
	// isn't listed) still gets an entry, under the last group, so the menu
	// always reflects the active filter.
	const shown = $derived.by((): FilterOption[] => {
		const known = new Set(options.map((o) => o.value));
		const group = options.at(-1)?.group;
		return [
			...options,
			...selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v, group }))
		];
	});

	const text = $derived.by(() => {
		if (selected.length === 0) return allLabel;
		if (selected.length > 1) return `${selected.length} ${noun}`;
		return shown.find((o) => o.value === selected[0])?.label ?? selected[0];
	});
	const mono = $derived(
		selected.length === 1 && (shown.find((o) => o.value === selected[0])?.mono ?? false)
	);

	// Groups in first-seen order; ungrouped options come first.
	const groups = $derived.by(() => {
		const out = new Map<string, FilterOption[]>();
		for (const o of shown) out.set(o.group ?? '', [...(out.get(o.group ?? '') ?? []), o]);
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
			<DropdownMenu.Item onSelect={() => onchange([])}>
				{allLabel}
				{#if selected.length === 0}<Check class="ml-auto" />{/if}
			</DropdownMenu.Item>
			{#if shown.length}
				<div class="max-h-72 overflow-x-hidden overflow-y-auto">
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
