<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import CopyField from '$lib/components/copy-field.svelte';
	import TokenScopeFields from '$lib/components/token-scope-fields.svelte';
	import TokenTable from '$lib/components/token-table.svelte';
	import { Plus, TriangleAlert } from '@lucide/svelte';
	import FilterMenu from '$lib/components/filter-menu.svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { goto } from '$app/navigation';
	import {
		TOKEN_STATUSES,
		tokenFilterParams,
		type TokenFilters,
		type TokenStatus
	} from '$lib/token-filters';

	let { data, form } = $props();
	let issuing = $state(false);
	let sheetOpen = $state(false);

	/** This view's URL with the filters (optionally patched) and a page. */
	function href(
		page: number,
		patch: Partial<TokenFilters> = {},
		view: 'mine' | 'all' = data.view
	): string {
		const params = tokenFilterParams({ ...data.filters, ...patch });
		if (view === 'all') params.set('view', 'all');
		if (page > 1) params.set('page', String(page));
		return `?${params}`;
	}

	/** A filter change starts over at page 1. */
	function applyFilter(patch: Partial<TokenFilters>, view: 'mine' | 'all' = data.view) {
		goto(href(1, patch, view), { replaceState: true, keepFocus: true, noScroll: true });
	}

	// A date input reports every valid intermediate value while a year is
	// typed (0002, 0020, …), so dates apply once the input settles.
	let dateTimer: ReturnType<typeof setTimeout>;
	function applyDate(patch: Partial<TokenFilters>) {
		clearTimeout(dateTimer);
		dateTimer = setTimeout(() => applyFilter(patch), 400);
	}

	const cleared = $derived(data.view === 'all' ? '?view=all' : '?');
	// Suspended means the owner is deactivated, which your own tokens never are.
	const statuses = $derived(
		data.view === 'all' ? TOKEN_STATUSES : TOKEN_STATUSES.filter((s) => s !== 'suspended')
	);

	// Whose tokens: yours, everyone's, or any set of owners (the everyone
	// view narrowed to them). Admins only; members can only see their own.
	// Suspended only exists outside your own view, so it's dropped when
	// switching back to it.
	function pickMine() {
		applyFilter(
			{ users: [], statuses: data.filters.statuses.filter((x) => x !== 'suspended') },
			'mine'
		);
	}
	const ownerDisplay = $derived(data.view === 'mine' ? 'Mine' : undefined);
	const ownerPresets = $derived([
		{ label: 'Mine', active: data.view === 'mine', onselect: pickMine },
		{
			label: 'All owners',
			active: data.view === 'all' && data.filters.users.length === 0,
			onselect: () => applyFilter({ users: [] }, 'all')
		}
	]);
	const statusOptions = $derived(
		statuses.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))
	);

	// Every owner, you marked as such; an owner from a shared link who isn't
	// listed still gets an entry, so the menu reflects the filter.
	const ownerOptions = $derived([
		...data.owners.map((o) => ({
			value: o.id,
			label: o.id === data.user.id ? `${o.label} (you)` : o.label,
			group: 'Owners'
		})),
		...data.filters.users
			.filter((u) => !data.owners.some((o) => o.id === u))
			.map((u) => ({ value: u, label: u, group: 'Owners' }))
	]);
</script>

{#snippet dateRange(label: string, from: keyof TokenFilters, to: keyof TokenFilters)}
	{@const set = Boolean(data.filters[from] || data.filters[to])}
	<!-- One control, not three loose parts: the label is the field's prefix
	     and both dates share its border, so a range reads (and wraps) as a
	     unit. The label brightens while the range is filtering. -->
	<fieldset
		class="flex h-8 w-full min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-background text-sm shadow-(--shadow-panel) transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 sm:w-auto dark:bg-input/30"
	>
		<legend class="sr-only">{label}</legend>
		<span
			aria-hidden="true"
			class="flex items-center border-r border-input bg-subtle px-2 sm:px-2.5 {set
				? 'font-medium text-foreground'
				: 'text-muted-foreground'}">{label}</span
		>
		<input
			type="date"
			aria-label="{label} from"
			class="range-date"
			value={data.filters[from] ?? ''}
			onchange={(e) => applyDate({ [from]: e.currentTarget.value || null })}
		/>
		<span aria-hidden="true" class="flex items-center text-muted-foreground">–</span>
		<input
			type="date"
			aria-label="{label} to"
			class="range-date"
			value={data.filters[to] ?? ''}
			onchange={(e) => applyDate({ [to]: e.currentTarget.value || null })}
		/>
	</fieldset>
{/snippet}

<Page>
	<PageHeader
		title="Tokens"
		description="API tokens for CI and scripts. A token can't exceed your own access."
	>
		{#snippet actions()}
			<Button onclick={() => (sheetOpen = true)}><Plus /> New token</Button>
		{/snippet}
	</PageHeader>

	{#if form?.issued}
		<div
			class="mb-6 rounded-lg border border-primary/30 bg-accent/60 p-4 shadow-(--shadow-panel)"
			role="status"
		>
			<div class="mb-3 flex items-center gap-2 text-sm font-medium text-accent-foreground">
				<TriangleAlert class="size-4" />
				Copy “{form.issued.name}” now. It won't be shown again.
			</div>
			<CopyField text={form.issued.token} label="Copy token" />
		</div>
	{/if}

	<div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
		<!-- Two clusters that wrap whole: whose and what, then when. -->
		<div class="flex flex-wrap items-center gap-2">
			<!-- Members only ever see their own tokens: the owner filter shows
			     that, disabled, so the toolbar reads the same for everyone. -->
			<FilterMenu
				label="Whose tokens"
				noun="owners"
				allLabel="All owners"
				options={ownerOptions}
				selected={data.view === 'all' ? data.filters.users : []}
				onchange={(users) => applyFilter({ users }, 'all')}
				presets={ownerPresets}
				display={ownerDisplay}
				disabled={!data.isAdmin}
			/>
			<FilterMenu
				label="Filter by status"
				noun="statuses"
				allLabel="Any status"
				options={statusOptions}
				selected={data.filters.statuses}
				onchange={(picked) => applyFilter({ statuses: picked as TokenStatus[] })}
			/>
		</div>
		<div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
			{@render dateRange('Created', 'createdFrom', 'createdTo')}
			{@render dateRange('Expires', 'expiresFrom', 'expiresTo')}
		</div>
		{#if data.filtered}
			<Button variant="ghost" size="sm" href={cleared} data-sveltekit-noscroll class="ml-auto"
				>Clear filters</Button
			>
		{/if}
	</div>

	<TokenTable
		tokens={data.tokens}
		emptyText={data.filtered
			? 'No tokens match.'
			: data.view === 'all'
				? 'Nobody has a token.'
				: 'Create one for CI or scripts.'}
	/>

	{#if data.view === 'all' && (data.page > 1 || data.hasMore)}
		<div class="mt-3 flex items-center justify-between gap-3">
			<p class="text-xs text-muted-foreground tabular-nums">Page {data.page}, newest first</p>
			<div class="flex items-center gap-2">
				{#if data.page > 1}
					<Button variant="outline" size="sm" href={href(data.page - 1)}>Previous</Button>
				{:else}
					<Button variant="outline" size="sm" disabled>Previous</Button>
				{/if}
				{#if data.hasMore}
					<Button variant="outline" size="sm" href={href(data.page + 1)}>Next</Button>
				{:else}
					<Button variant="outline" size="sm" disabled>Next</Button>
				{/if}
			</div>
		</div>
	{/if}
</Page>

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content side="right" class="w-full gap-0 sm:max-w-md">
		<Sheet.Header class="border-b px-6 py-5">
			<Sheet.Title class="text-base font-semibold">New token</Sheet.Title>
			<Sheet.Description>Shown once after creation.</Sheet.Description>
		</Sheet.Header>
		<form
			method="POST"
			action="?/issue"
			use:enhance={() => {
				issuing = true;
				return async ({ result, update }) => {
					await update();
					issuing = false;
					// Keep the sheet up to show a validation error; close it once the
					// token exists so the one-time copy banner is in view.
					if (result.type === 'success') sheetOpen = false;
				};
			}}
			class="flex min-h-0 flex-1 flex-col"
		>
			<div class="flex-1 space-y-5 overflow-y-auto px-6 py-5">
				<div class="space-y-2">
					<Label for="name">Name</Label>
					<Input id="name" name="name" placeholder="ci-deploy" />
				</div>

				<TokenScopeFields
					scopeOptions={data.scopeOptions}
					advanced
					allowGc={data.user.role === 'admin'}
				/>

				{#if form?.error}
					<p role="alert" class="text-sm text-destructive">{form.error}</p>
				{/if}
			</div>
			<div class="flex justify-end gap-2 border-t bg-subtle px-6 py-4">
				<Button variant="ghost" onclick={() => (sheetOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={issuing}>
					{issuing ? 'Creating…' : 'Create token'}
				</Button>
			</div>
		</form>
	</Sheet.Content>
</Sheet.Root>

<style>
	/* The date inputs inside a joined range field: the field draws the
	   border, focus ring and background. */
	.range-date {
		flex: 1 1 0;
		font-size: inherit;
		min-width: 0;
		border: 0;
		background: transparent;
		padding: 0 0.25rem 0 0.5rem;
		font-variant-numeric: tabular-nums;
		outline: none;
		color: var(--foreground);
	}
	@media (min-width: 40rem) {
		.range-date {
			flex: none;
			width: 8.5rem;
		}
	}
</style>
