<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import CopyField from '$lib/components/copy-field.svelte';
	import TokenScopeFields from '$lib/components/token-scope-fields.svelte';
	import TokenTable from '$lib/components/token-table.svelte';
	import { Plus, TriangleAlert } from '@lucide/svelte';
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
	function href(page: number, patch: Partial<TokenFilters> = {}): string {
		const params = tokenFilterParams({ ...data.filters, ...patch });
		if (data.view === 'all') params.set('view', 'all');
		if (page > 1) params.set('page', String(page));
		return `?${params}`;
	}

	/** A filter change starts over at page 1. */
	function applyFilter(patch: Partial<TokenFilters>) {
		goto(href(1, patch), { replaceState: true, keepFocus: true, noScroll: true });
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
	// An owner from a shared link who isn't in the list still gets an option,
	// so the select reflects the active filter.
	const ownerOptions = $derived(
		data.filters.user && !data.owners.some((o) => o.id === data.filters.user)
			? [...data.owners, { id: data.filters.user, label: data.filters.user }]
			: data.owners
	);
</script>

{#snippet dateRange(label: string, from: keyof TokenFilters, to: keyof TokenFilters)}
	<fieldset class="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
		<legend class="sr-only">{label}</legend>
		<span aria-hidden="true">{label}</span>
		<Input
			type="date"
			aria-label="{label} from"
			class="h-8 w-36"
			value={data.filters[from] ?? ''}
			onchange={(e) => applyDate({ [from]: e.currentTarget.value || null })}
		/>
		<span aria-hidden="true">–</span>
		<Input
			type="date"
			aria-label="{label} to"
			class="h-8 w-36"
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

	{#if data.isAdmin}
		<div
			role="tablist"
			aria-label="Whose tokens"
			class="mb-4 inline-flex rounded-lg border bg-subtle p-0.5 text-sm"
		>
			{#each [{ value: 'mine', label: 'Yours', href: '?' }, { value: 'all', label: 'Everyone', href: '?view=all' }] as opt (opt.value)}
				<a
					role="tab"
					aria-selected={data.view === opt.value}
					href={opt.href}
					data-sveltekit-noscroll
					class="rounded-md px-3 py-1 font-medium transition-colors {data.view === opt.value
						? 'bg-background text-foreground shadow-(--shadow-sheet)'
						: 'text-muted-foreground hover:text-foreground'}">{opt.label}</a
				>
			{/each}
		</div>
	{/if}

	<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
		<select
			aria-label="Filter by status"
			class="native-select w-36"
			value={data.filters.status ?? ''}
			onchange={(e) =>
				applyFilter({ status: (e.currentTarget.value || null) as TokenStatus | null })}
		>
			<option value="">Any status</option>
			{#each statuses as status (status)}
				<option value={status}>{status[0].toUpperCase() + status.slice(1)}</option>
			{/each}
		</select>
		<!-- Admins switch between Yours and Everyone: the owner slot stays in
		     both (fixed to you in Yours) so the other fields don't shift. -->
		{#if data.view === 'all'}
			<select
				aria-label="Filter by owner"
				class="native-select w-48"
				value={data.filters.user ?? ''}
				onchange={(e) => applyFilter({ user: e.currentTarget.value || null })}
			>
				<option value="">Any owner</option>
				{#each ownerOptions as owner (owner.id)}
					<option value={owner.id}>{owner.label}</option>
				{/each}
			</select>
		{:else if data.isAdmin}
			<select aria-label="Owner" class="native-select w-48" disabled>
				<option>You</option>
			</select>
		{/if}
		{@render dateRange('Created', 'createdFrom', 'createdTo')}
		{@render dateRange('Expires', 'expiresFrom', 'expiresTo')}
		{#if data.filtered}
			<Button variant="ghost" size="sm" href={cleared} data-sveltekit-noscroll>Clear filters</Button
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
