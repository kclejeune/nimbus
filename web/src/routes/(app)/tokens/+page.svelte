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

	let { data, form } = $props();
	let issuing = $state(false);
	let sheetOpen = $state(false);
</script>

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

	<TokenTable
		tokens={data.tokens}
		emptyText={data.view === 'all' ? 'Nobody has a token.' : 'Create one for CI or scripts.'}
	/>

	{#if data.view === 'all' && (data.page > 1 || data.hasMore)}
		<div class="mt-3 flex items-center justify-between gap-3">
			<p class="text-xs text-muted-foreground tabular-nums">Page {data.page}, newest first</p>
			<div class="flex items-center gap-2">
				{#if data.page > 1}
					<Button variant="outline" size="sm" href="?view=all&page={data.page - 1}">Previous</Button
					>
				{:else}
					<Button variant="outline" size="sm" disabled>Previous</Button>
				{/if}
				{#if data.hasMore}
					<Button variant="outline" size="sm" href="?view=all&page={data.page + 1}">Next</Button>
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
