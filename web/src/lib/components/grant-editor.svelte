<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Trash2 } from '@lucide/svelte';

	let { grants }: { grants: { id: string; pattern: string; actions: string }[] } = $props();

	const BITS = [
		{ name: 'r', label: 'Pull' },
		{ name: 'w', label: 'Push' },
		{ name: 'd', label: 'Delete paths' },
		{ name: 'cc', label: 'Create cache' },
		{ name: 'cr', label: 'Configure' },
		{ name: 'cq', label: 'Retention' },
		{ name: 'cd', label: 'Destroy cache' },
		{ name: 'gc', label: 'Trigger GC' }
	];

	function grantLabel(actions: string): string {
		try {
			const parsed = JSON.parse(actions);
			return BITS.filter((b) => parsed[b.name] === 1)
				.map((b) => b.label)
				.join(', ');
		} catch {
			return actions;
		}
	}
</script>

<section class="rounded-lg border bg-card p-5">
	<h2 class="mb-4 text-sm font-medium">Grants</h2>
	<ul class="mb-4 divide-y">
		{#each grants as grant (grant.id)}
			<li class="flex items-center justify-between py-2">
				<span class="text-sm">
					<code class="rounded bg-muted px-1.5 py-0.5">{grant.pattern}</code>
					· {grantLabel(grant.actions)}
				</span>
				<form method="POST" action="?/removeGrant" use:enhance>
					<input type="hidden" name="id" value={grant.id} />
					<Button type="submit" variant="ghost" size="icon" aria-label="Remove grant">
						<Trash2 class="size-4" />
					</Button>
				</form>
			</li>
		{:else}
			<li class="py-2 text-sm text-muted-foreground">No grants.</li>
		{/each}
	</ul>
	<form method="POST" action="?/addGrant" use:enhance class="space-y-4">
		<div class="space-y-2">
			<Label for="pattern">Cache pattern</Label>
			<Input id="pattern" name="pattern" required placeholder="ci-* or nixos or *" class="w-64" />
		</div>
		<div class="flex flex-wrap gap-4">
			{#each BITS as bit (bit.name)}
				<label class="flex items-center gap-2 text-sm">
					<input name={bit.name} type="checkbox" class="size-4 rounded border-input text-primary" />
					{bit.label}
				</label>
			{/each}
		</div>
		<Button type="submit" variant="secondary">Add grant</Button>
	</form>
</section>
