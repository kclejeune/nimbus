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
		description="Scoped API tokens for CI and scripts. A token can never exceed your own access, and revoking one takes effect immediately."
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

	<TokenTable
		tokens={data.tokens}
		emptyText="Create a token to push from CI or run scripts against the cache API."
	/>
</Page>

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content side="right" class="w-full gap-0 sm:max-w-md">
		<Sheet.Header class="border-b px-6 py-5">
			<Sheet.Title class="text-base font-semibold">New token</Sheet.Title>
			<Sheet.Description>
				The token is shown once after it's created. Store it in your CI secrets right away.
			</Sheet.Description>
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
