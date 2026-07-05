<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import TokenScopeFields from '$lib/components/token-scope-fields.svelte';
	import { TerminalSquare, Check } from '@lucide/svelte';

	let { data, form } = $props();
	const canApprove = $derived(data.grant && data.grant.status === 'pending' && !data.grant.expired);
</script>

<div class="flex min-h-svh items-center justify-center bg-background px-4">
	<div class="w-full max-w-md">
		<div class="mb-6 flex flex-col items-center text-center">
			<div
				class="mb-4 flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground"
			>
				<TerminalSquare class="size-6" />
			</div>
			<h1 class="text-xl font-semibold tracking-tight">Device login</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Signed in as {data.user.email ?? data.user.name}. Enter the code shown in your terminal.
			</p>
		</div>

		{#if form?.approved}
			<div class="rounded-lg border border-primary/40 bg-accent/40 p-6 text-center">
				<Check class="mx-auto mb-2 size-6 text-primary" />
				<p class="text-sm font-medium">Approved</p>
				<p class="mt-1 text-sm text-muted-foreground">
					Return to your terminal — the CLI will finish signing in.
				</p>
			</div>
		{:else if !data.code}
			<form method="GET" class="space-y-4 rounded-lg border bg-card p-6">
				<div class="space-y-2">
					<Label for="code">Device code</Label>
					<Input id="code" name="code" placeholder="XXXX-XXXX" autocomplete="off" autofocus />
				</div>
				<Button type="submit" class="w-full">Continue</Button>
			</form>
		{:else if data.notFound}
			<div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
				No pending login found for <span class="font-mono text-foreground">{data.code}</span>.
				<a href="/cli/device" class="text-primary hover:underline">Try again</a>.
			</div>
		{:else if data.grant && (data.grant.status !== 'pending' || data.grant.expired)}
			<div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
				{data.grant.expired ? 'This code has expired.' : 'This code was already used.'}
				<a href="/cli/device" class="text-primary hover:underline">Start again</a>.
			</div>
		{:else}
			<form method="POST" action="?/approve" class="space-y-5 rounded-lg border bg-card p-6">
				<input type="hidden" name="user_code" value={data.code} />
				<p class="text-sm text-muted-foreground">
					Authorizing device code
					<span class="font-mono font-medium text-foreground">{data.code}</span>.
				</p>

				<div class="space-y-2">
					<Label for="label">Token name</Label>
					<Input id="label" name="label" value="attic CLI" />
				</div>

				<TokenScopeFields cacheNames={data.cacheNames} defaultPush={true} />

				{#if form?.error}
					<p class="text-sm text-destructive">{form.error}</p>
				{/if}

				<Button type="submit" class="w-full" disabled={!canApprove}>Authorize</Button>
			</form>
		{/if}
	</div>
</div>
