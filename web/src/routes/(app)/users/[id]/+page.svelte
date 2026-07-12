<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import GrantEditor from '$lib/components/grant-editor.svelte';

	let { data, form } = $props();
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">{data.subject.name}</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			{data.subject.email}
			<Badge variant={data.subject.role === 'admin' ? 'default' : 'secondary'}>
				{data.subject.role}
			</Badge>
		</p>
	</header>

	{#if form?.error}
		<p class="mb-4 text-sm text-destructive">{form.error}</p>
	{/if}

	{#if data.subject.role === 'admin'}
		<p class="mb-8 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
			Admins bypass grants and hold every permission; grants below only take effect if this user is
			demoted to member.
		</p>
	{/if}

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="mb-4 text-sm font-medium">Groups</h2>
		<ul class="divide-y">
			{#each data.memberships as membership (membership.id)}
				<li class="flex items-center gap-2 py-2 text-sm">
					<a href="/groups/{membership.id}" class="hover:underline">{membership.name}</a>
					{#if membership.source === 'sso'}<Badge variant="secondary">sso</Badge>{/if}
				</li>
			{:else}
				<li class="py-2 text-sm text-muted-foreground">No group memberships.</li>
			{/each}
		</ul>
	</section>

	<GrantEditor grants={data.grants} />
</div>
