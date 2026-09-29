<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import TokenScopeFields from '$lib/components/token-scope-fields.svelte';
	import { Check } from '@lucide/svelte';
	import AuthShell from '$lib/components/layout/auth-shell.svelte';

	let { data, form } = $props();
	const canApprove = $derived(data.grant && data.grant.status === 'pending' && !data.grant.expired);
</script>

<AuthShell
	title="Sign in a device"
	description="Signed in as {data.user.email ??
		data.user.name}. Enter the code shown in your terminal."
>
	{#if form?.approved}
		<div class="flex items-start gap-3">
			<div class="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/12">
				<Check class="size-4 text-success" />
			</div>
			<div>
				<p class="text-sm font-medium">Device authorized</p>
				<p class="mt-0.5 text-sm text-muted-foreground">
					Return to your terminal. The CLI will finish signing in.
				</p>
			</div>
		</div>
	{:else if !data.code}
		<form method="GET" class="space-y-4">
			<div class="space-y-2">
				<Label for="code">Device code</Label>
				<Input
					id="code"
					name="code"
					placeholder="XXXX-XXXX"
					autocomplete="off"
					autofocus
					class="h-11 text-center font-mono text-lg tracking-[0.2em] uppercase md:text-lg"
				/>
			</div>
			<Button type="submit" size="lg" class="w-full">Continue</Button>
		</form>
	{:else if data.notFound}
		<p class="text-sm text-muted-foreground">
			No pending sign-in matches <span class="font-mono text-foreground">{data.code}</span>. Check
			the code in your terminal and
			<a href="/cli/device" class="font-medium text-primary hover:underline">enter it again</a>.
		</p>
	{:else if data.grant && (data.grant.status !== 'pending' || data.grant.expired)}
		<p class="text-sm text-muted-foreground">
			{data.grant.expired ? 'This code has expired.' : 'This code has already been used.'}
			Run the login command again for a new one, then
			<a href="/cli/device" class="font-medium text-primary hover:underline">enter it here</a>.
		</p>
	{:else}
		<form method="POST" action="?/approve" class="space-y-5">
			<input type="hidden" name="user_code" value={data.code} />
			<div class="flex items-center justify-between rounded-lg border bg-subtle px-3 py-2.5">
				<span class="text-sm text-muted-foreground">Device code</span>
				<span class="font-mono text-sm font-medium tracking-[0.15em]">{data.code}</span>
			</div>

			<div class="space-y-2">
				<Label for="label">Token name</Label>
				<Input id="label" name="label" value="nimbus CLI" />
			</div>

			<TokenScopeFields scopeOptions={data.scopeOptions} defaultPush={true} />

			{#if form?.error}
				<p role="alert" class="text-sm text-destructive">{form.error}</p>
			{/if}

			<Button type="submit" size="lg" class="w-full" disabled={!canApprove}>Authorize device</Button
			>
		</form>
	{/if}
</AuthShell>
