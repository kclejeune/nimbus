<script lang="ts">
	import LoginForm from '$lib/components/login-form.svelte';
	import AuthShell from '$lib/components/layout/auth-shell.svelte';

	let { data } = $props();
</script>

<AuthShell title="Sign in">
	<LoginForm
		providers={data.providers}
		accessConfigured={data.accessConfigured}
		redirectTo={data.redirectTo}
		errorCode={data.errorCode}
	/>
</AuthShell>
