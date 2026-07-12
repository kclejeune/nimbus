<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import CopyField from '$lib/components/copy-field.svelte';
	import TokenScopeFields from '$lib/components/token-scope-fields.svelte';
	import TokenTable from '$lib/components/token-table.svelte';
	import { TriangleAlert } from '@lucide/svelte';

	let { data, form } = $props();
	let issuing = $state(false);
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Tokens</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Scoped API tokens for CI and programmatic access. Revoking one takes effect immediately.
		</p>
	</header>

	{#if form?.issued}
		<div class="mb-8 rounded-lg border border-primary/40 bg-accent/40 p-4">
			<div class="mb-2 flex items-center gap-2 text-sm font-medium">
				<TriangleAlert class="size-4 text-primary" />
				Copy “{form.issued.name}” now — it won't be shown again.
			</div>
			<CopyField text={form.issued.token} label="Copy token" />
		</div>
	{/if}

	<section class="mb-10 rounded-lg border bg-card p-5">
		<h2 class="mb-4 text-sm font-medium">Issue a token</h2>
		<form
			method="POST"
			action="?/issue"
			use:enhance={() => {
				issuing = true;
				return async ({ update }) => {
					await update();
					issuing = false;
				};
			}}
			class="space-y-4"
		>
			<div class="space-y-2">
				<Label for="name">Name</Label>
				<Input id="name" name="name" placeholder="ci-deploy" />
			</div>

			<TokenScopeFields scopeOptions={data.scopeOptions} advanced />

			{#if form?.error}
				<p class="text-sm text-destructive">{form.error}</p>
			{/if}

			<Button type="submit" disabled={issuing}>{issuing ? 'Issuing…' : 'Issue token'}</Button>
		</form>
	</section>

	<h2 class="mb-3 text-sm font-medium">Your tokens</h2>
	<TokenTable tokens={data.tokens} />
</div>
