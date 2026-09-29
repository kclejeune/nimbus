<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import GrantBitsPicker from '$lib/components/grant-bits-picker.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { Plus, Trash2 } from '@lucide/svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

	let {
		grants,
		cacheNames = [],
		editable = true
	}: {
		grants: { id: string; pattern: string; actions: string; matches: number }[];
		/** Existing cache names, for the pattern autocomplete. */
		cacheNames?: string[];
		/** Admins edit; a member viewing their own page gets the read-only view. */
		editable?: boolean;
	} = $props();

	const isGlob = (pattern: string) => /[*?]/.test(pattern);
</script>

<Panel
	title="Cache access"
	description="Direct grants. Patterns like ci-* cover every matching cache, including ones created later."
	flush
>
	<div class="overflow-x-auto">
		<table class="data-table">
			<thead>
				<tr>
					<th>Cache</th>
					<th>Permissions</th>
					<th>Applies to</th>
					{#if editable}
						<th class="w-14"><span class="sr-only">Actions</span></th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each grants as grant (grant.id)}
					<tr>
						<td>
							{#if !isGlob(grant.pattern) && grant.matches > 0}
								<a
									href="/caches/{grant.pattern}/settings"
									class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs underline-offset-4 hover:text-primary hover:underline"
									>{grant.pattern}</a
								>
							{:else}
								<code class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs"
									>{grant.pattern}</code
								>
							{/if}
						</td>
						<td class="text-muted-foreground">{formatGrantActions(grant.actions)}</td>
						<td>
							{#if grant.matches === 0}
								<StatusBadge tone="warning">
									{isGlob(grant.pattern) ? 'Matches no caches' : 'No cache with this name'}
								</StatusBadge>
							{:else if isGlob(grant.pattern)}
								<span class="text-sm text-muted-foreground tabular-nums">
									{grant.matches}
									{grant.matches === 1 ? 'cache' : 'caches'}
								</span>
							{:else}
								<span class="text-sm text-muted-foreground">This cache</span>
							{/if}
						</td>
						{#if editable}
							<td class="!py-1 text-right">
								<form method="POST" action="?/removeGrant" use:enhance={toastErrors()}>
									<input type="hidden" name="id" value={grant.id} />
									<Button
										type="submit"
										variant="ghost"
										size="icon-sm"
										class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
										aria-label="Remove grant for {grant.pattern}"
									>
										<Trash2 />
									</Button>
								</form>
							</td>
						{/if}
					</tr>
				{:else}
					<tr>
						<td colspan={editable ? 4 : 3} class="py-6 text-center text-sm text-muted-foreground">
							No cache access granted directly.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if editable}
		<form
			method="POST"
			action="?/addGrant"
			use:enhance={toastErrors()}
			class="space-y-4 border-t bg-subtle px-5 py-4"
		>
			<div class="space-y-2">
				<Label for="pattern">Cache name or pattern</Label>
				<Input
					id="pattern"
					name="pattern"
					required
					placeholder="ci-* or nixos or *"
					class="w-64 max-w-full font-mono"
					autocomplete="off"
					list="grant-cache-names"
				/>
				<datalist id="grant-cache-names">
					{#each cacheNames as name (name)}
						<option value={name}></option>
					{/each}
				</datalist>
			</div>
			<GrantBitsPicker />
			<Button type="submit"><Plus /> Grant access</Button>
		</form>
	{/if}
</Panel>
