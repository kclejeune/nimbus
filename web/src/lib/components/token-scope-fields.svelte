<script lang="ts">
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { PERMISSION_BIT_FIELDS } from '$lib/permission-bits';
	import type { ScopeOption } from '$lib/server/auth/permissions';

	let {
		scopeOptions,
		defaultPush = false,
		advanced = false,
		allowGc = false
	}: {
		scopeOptions: ScopeOption[];
		defaultPush?: boolean;
		/** Show the cache-management bits (tokens page yes, device flow no). */
		advanced?: boolean;
		/** Offer the storage-wide GC claim (admins on the tokens page only). */
		allowGc?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally -- initial selection only; options are fixed per load
	let selected = $state(scopeOptions[0]?.value ?? '*');
	const bits = $derived(scopeOptions.find((o) => o.value === selected)?.bits ?? {});

	const BASIC = PERMISSION_BIT_FIELDS.filter((f) => f.bit === 'r' || f.bit === 'w');
	const ADVANCED = PERMISSION_BIT_FIELDS.filter((f) => f.bit !== 'r' && f.bit !== 'w');
</script>

<div class="grid gap-4 sm:grid-cols-2">
	<div class="space-y-2">
		<Label for="cache">Scope</Label>
		<select id="cache" name="cache" bind:value={selected} class="native-select">
			{#each scopeOptions as option (option.value)}
				<option value={option.value}>{option.value === '*' ? 'All caches' : option.value}</option>
			{/each}
		</select>
		{#if scopeOptions.length === 0}
			<p class="text-sm text-muted-foreground">You have no cache permissions to delegate.</p>
		{/if}
	</div>
	<div class="space-y-2">
		<Label for="expiry_days">Expires (days)</Label>
		<Input id="expiry_days" name="expiry_days" type="number" value="90" min="1" max="3650" />
	</div>
</div>

<fieldset class="space-y-2">
	<legend class="mb-2 text-sm font-medium">Permissions</legend>
	<div class="flex flex-wrap gap-2">
		{#each BASIC as p (p.field)}
			<label class="check-chip">
				<input
					name={p.field}
					type="checkbox"
					checked={bits[p.bit] === 1 && (p.bit === 'r' || defaultPush)}
					disabled={!bits[p.bit]}
				/>
				{p.label}
			</label>
		{/each}
		{#if advanced}
			{#each ADVANCED as p (p.field)}
				<label class="check-chip">
					<input name={p.field} type="checkbox" disabled={!bits[p.bit]} />
					{p.label}
				</label>
			{/each}
		{/if}
		{#if allowGc}
			<label
				class="check-chip"
				title="Storage-wide: lets the token trigger garbage collection via the API, independent of the cache scope"
			>
				<input name="gc" type="checkbox" />
				Garbage collection
			</label>
			<label
				class="check-chip"
				title="Trust admin: lets the token change trust-affecting cache settings via the API (signing keypair, visibility)"
			>
				<input name="ct" type="checkbox" />
				Trust admin
			</label>
		{/if}
	</div>
</fieldset>
