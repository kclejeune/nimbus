<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import TokenScopeFields from '$lib/components/token-scope-fields.svelte';
	import AuthShell from '$lib/components/layout/auth-shell.svelte';

	let { data, form } = $props();
</script>

<AuthShell title="Authorize the nimbus CLI">
	{#snippet description()}
		Signed in as {data.user.email ?? data.user.name}. A token for
		<span class="font-mono text-[0.875rem] text-foreground">{data.hostname || 'this machine'}</span>
		will be sent to the CLI waiting on
		<span class="font-mono text-[0.875rem] text-foreground">127.0.0.1:{data.port}</span>.
	{/snippet}
	<form method="POST" action="?/authorize" class="space-y-5">
		<input type="hidden" name="port" value={data.port} />
		<input type="hidden" name="state" value={data.state} />

		<div class="space-y-2">
			<Label for="label">Token name</Label>
			<Input id="label" name="label" value={data.label} />
		</div>

		<TokenScopeFields scopeOptions={data.scopeOptions} defaultPush={true} />

		{#if form?.error}
			<p role="alert" class="text-sm text-destructive">{form.error}</p>
		{/if}

		<Button type="submit" size="lg" class="w-full">Authorize CLI</Button>
		<p class="text-center text-xs text-muted-foreground">
			You can revoke this token at any time from Tokens.
		</p>
	</form>
</AuthShell>
