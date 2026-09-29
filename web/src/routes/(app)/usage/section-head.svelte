<script lang="ts">
	let {
		title,
		description,
		class: className = ''
	}: { title: string; description: string; class?: string } = $props();
</script>

<div class={className}>
	<h2 class="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
	<p class="mt-0.5 text-sm text-muted-foreground">{description}</p>
</div>
