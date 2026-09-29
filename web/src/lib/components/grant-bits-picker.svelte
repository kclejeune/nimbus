<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { GRANT_BIT_OPTIONS } from '$lib/permission-bits';

	// Checkbox inputs post the bit itself as the field name (parseGrantActions);
	// the containing <form> serializes them, so no value needs to leave here.
	let checked = $state<Record<string, boolean>>({});
</script>

<div class="flex flex-wrap items-center gap-2">
	{#each GRANT_BIT_OPTIONS as bit (bit.name)}
		<label class="check-chip">
			<input name={bit.name} type="checkbox" bind:checked={checked[bit.name]} />
			{bit.label}
		</label>
	{/each}
	<Button
		type="button"
		variant="ghost"
		size="sm"
		onclick={() => {
			for (const bit of GRANT_BIT_OPTIONS) checked[bit.name] = true;
		}}
	>
		Full control
	</Button>
</div>
