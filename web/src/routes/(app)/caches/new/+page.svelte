<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ArrowLeft } from '@lucide/svelte';

	let { form } = $props();
	let submitting = $state(false);
	const v = $derived(form?.values);
</script>

<div class="mx-auto max-w-xl px-8 py-8">
	<a
		href="/caches"
		class="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" /> Caches
	</a>

	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">New cache</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			A signing keypair is generated automatically. The public key is shown after creation.
		</p>
	</header>

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
		class="space-y-6"
	>
		<div class="space-y-2">
			<Label for="name">Name</Label>
			<Input id="name" name="name" placeholder="my-cache" value={v?.name ?? ''} autofocus />
			<p class="text-xs text-muted-foreground">Lowercase letters, digits, and dashes.</p>
		</div>

		<div class="flex items-center gap-3">
			<input
				id="is_public"
				name="is_public"
				type="checkbox"
				checked={v?.isPublic ?? false}
				class="size-4 rounded border-input text-primary focus:ring-ring"
			/>
			<Label for="is_public" class="font-normal">Public — anyone can pull without a token</Label>
		</div>

		<div class="grid grid-cols-2 gap-4">
			<div class="space-y-2">
				<Label for="priority">Priority</Label>
				<Input id="priority" name="priority" type="number" value={v?.priority ?? 40} />
			</div>
			<div class="space-y-2">
				<Label for="compression">Compression</Label>
				<select
					id="compression"
					name="compression"
					value={v?.compression ?? 'zstd'}
					class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				>
					<option value="zstd">zstd</option>
					<option value="gzip">gzip</option>
					<option value="none">none</option>
				</select>
			</div>
		</div>

		<div class="space-y-2">
			<Label for="retention_period">Retention (days)</Label>
			<Input
				id="retention_period"
				name="retention_period"
				type="number"
				placeholder="Leave blank for no automatic expiry"
				value={v?.retentionRaw ?? ''}
			/>
		</div>

		{#if form?.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}

		<div class="flex gap-3">
			<Button type="submit" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create cache'}
			</Button>
			<Button variant="ghost" href="/caches">Cancel</Button>
		</div>
	</form>
</div>
