<script lang="ts">
	import { enhance } from '$app/forms';
	import { CACHE_NAME_HINT } from '$lib/utils';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Globe, Lock } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';

	let { form } = $props();
	let submitting = $state(false);
	const v = $derived(form?.values);
</script>

<Page width="narrow">
	<PageHeader title="New cache" description="A signing keypair is generated automatically." />

	<form
		method="POST"
		use:enhance={toastErrors(() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		})}
	>
		<Panel>
			<div class="space-y-6">
				<div class="space-y-2">
					<Label for="name">Name</Label>
					<Input
						id="name"
						name="name"
						placeholder="my-cache"
						value={v?.name ?? ''}
						autofocus
						class="font-mono"
					/>
					<p class="text-xs text-muted-foreground">{CACHE_NAME_HINT}</p>
				</div>

				<fieldset>
					<legend class="mb-2 text-sm font-medium">Visibility</legend>
					<div class="grid gap-2 sm:grid-cols-2">
						<label
							class="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-checked:border-primary/50 has-checked:bg-accent/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
						>
							<input
								type="radio"
								name="is_public"
								value=""
								checked={!(v?.isPublic ?? false)}
								class="mt-0.5 size-4 border-input text-primary focus:ring-0 focus:ring-offset-0"
							/>
							<span>
								<span class="flex items-center gap-1.5 text-sm font-medium"
									><Lock class="size-3.5" /> Private</span
								>
								<span class="mt-0.5 block text-xs text-muted-foreground"
									>Pulling requires a token with read access.</span
								>
							</span>
						</label>
						<label
							class="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-checked:border-primary/50 has-checked:bg-accent/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
						>
							<input
								type="radio"
								name="is_public"
								value="on"
								checked={v?.isPublic ?? false}
								class="mt-0.5 size-4 border-input text-primary focus:ring-0 focus:ring-offset-0"
							/>
							<span>
								<span class="flex items-center gap-1.5 text-sm font-medium"
									><Globe class="size-3.5" /> Public</span
								>
								<span class="mt-0.5 block text-xs text-muted-foreground"
									>Anyone can pull. Pushing needs a token.</span
								>
							</span>
						</label>
					</div>
				</fieldset>

				<div class="grid gap-4 sm:grid-cols-3">
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
							class="native-select"
						>
							<option value="zstd">zstd</option>
							<option value="gzip">gzip</option>
							<option value="none">none</option>
						</select>
					</div>
					<div class="space-y-2">
						<Label for="retention_period">Retention (days)</Label>
						<Input
							id="retention_period"
							name="retention_period"
							type="number"
							placeholder="Forever"
							value={v?.retentionRaw ?? ''}
						/>
					</div>
				</div>
				<p class="-mt-3 text-xs text-muted-foreground">
					Lower priority wins across substituters. Blank retention keeps paths until removed.
				</p>

				{#if form?.error}
					<p role="alert" class="text-sm text-destructive">{form.error}</p>
				{/if}
			</div>

			{#snippet footer()}
				<span></span>
				<div class="flex gap-2">
					<Button variant="ghost" href="/caches">Cancel</Button>
					<Button type="submit" disabled={submitting}>
						{submitting ? 'Creating…' : 'Create cache'}
					</Button>
				</div>
			{/snippet}
		</Panel>
	</form>
</Page>
