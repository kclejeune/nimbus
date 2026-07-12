<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import GrantBitsPicker from '$lib/components/grant-bits-picker.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { Trash2 } from '@lucide/svelte';

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

<section class="rounded-lg border bg-card p-5">
	<h2 class="mb-4 text-sm font-medium">Cache access</h2>
	<div class="mb-4 overflow-x-auto rounded-lg border">
		<table class="w-full text-sm">
			<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
				<tr>
					<th class="px-4 py-2.5 font-medium">Cache</th>
					<th class="px-4 py-2.5 font-medium">Permissions</th>
					<th class="px-4 py-2.5 font-medium">Applies to</th>
					{#if editable}
						<th class="w-14 px-4 py-2.5"></th>
					{/if}
				</tr>
			</thead>
			<tbody class="divide-y">
				{#each grants as grant (grant.id)}
					<tr class="transition-colors hover:bg-muted/30">
						<td class="px-4 py-2.5">
							{#if !isGlob(grant.pattern) && grant.matches > 0}
								<a
									href="/caches/{grant.pattern}/settings"
									class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:underline"
									>{grant.pattern}</a
								>
							{:else}
								<code class="rounded bg-muted px-1.5 py-0.5 text-xs">{grant.pattern}</code>
							{/if}
						</td>
						<td class="px-4 py-2.5 text-muted-foreground">{formatGrantActions(grant.actions)}</td>
						<td class="px-4 py-2.5">
							{#if grant.matches === 0}
								<span class="text-xs font-medium text-amber-600 dark:text-amber-400">
									{isGlob(grant.pattern) ? 'matches no caches' : 'no cache with this name'}
								</span>
							{:else if isGlob(grant.pattern)}
								<span class="text-xs text-muted-foreground">
									{grant.matches}
									{grant.matches === 1 ? 'cache' : 'caches'}
								</span>
							{:else}
								<span class="text-xs text-muted-foreground">this cache</span>
							{/if}
						</td>
						{#if editable}
							<td class="px-4 py-1.5 text-right">
								<form method="POST" action="?/removeGrant" use:enhance={toastErrors()}>
									<input type="hidden" name="id" value={grant.id} />
									<Button type="submit" variant="ghost" size="icon" aria-label="Remove grant">
										<Trash2 class="size-4" />
									</Button>
								</form>
							</td>
						{/if}
					</tr>
				{:else}
					<tr>
						<td colspan={editable ? 4 : 3} class="px-4 py-3 text-sm text-muted-foreground">
							No cache access granted.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if editable}
		<form method="POST" action="?/addGrant" use:enhance={toastErrors()} class="space-y-4">
			<div class="space-y-2">
				<Label for="pattern">Cache name or pattern</Label>
				<Input
					id="pattern"
					name="pattern"
					required
					placeholder="ci-* or nixos or *"
					class="w-64"
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
			<Button type="submit" variant="secondary">Grant access</Button>
		</form>
	{/if}
</section>
