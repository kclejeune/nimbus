<script lang="ts">
	import LoginForm from '$lib/components/login-form.svelte';

	let { data } = $props();
</script>

<div class="flex min-h-svh w-full items-center justify-center bg-background px-4">
	<LoginForm
		providers={data.providers}
		accessConfigured={data.accessConfigured}
		redirectTo={data.redirectTo}
		errorCode={data.errorCode}
	/>
</div>
