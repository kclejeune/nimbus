<script lang="ts">
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	let {
		cacheNames,
		defaultPush = false,
		allowDelete = false
	}: { cacheNames: string[]; defaultPush?: boolean; allowDelete?: boolean } = $props();
</script>

<div class="grid grid-cols-2 gap-4">
	<div class="space-y-2">
		<Label for="cache">Cache</Label>
		<select
			id="cache"
			name="cache"
			class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
		>
			<option value="*">All caches</option>
			{#each cacheNames as name (name)}
				<option value={name}>{name}</option>
			{/each}
		</select>
	</div>
	<div class="space-y-2">
		<Label for="expiry_days">Expires (days)</Label>
		<Input id="expiry_days" name="expiry_days" type="number" value="90" min="1" max="3650" />
	</div>
</div>

<div class="flex gap-6">
	<label class="flex items-center gap-2 text-sm">
		<input name="pull" type="checkbox" checked class="size-4 rounded border-input text-primary" />
		Pull
	</label>
	<label class="flex items-center gap-2 text-sm">
		<input
			name="push"
			type="checkbox"
			checked={defaultPush}
			class="size-4 rounded border-input text-primary"
		/>
		Push
	</label>
	{#if allowDelete}
		<label class="flex items-center gap-2 text-sm">
			<input name="delete" type="checkbox" class="size-4 rounded border-input text-primary" />
			Delete
		</label>
	{/if}
</div>
