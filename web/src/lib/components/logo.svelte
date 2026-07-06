<script lang="ts">
	let { class: className = '' }: { class?: string } = $props();
</script>

<!-- The nimbus mark: a cloud with a Nix-style flake punched out of it. -->
<svg viewBox="0 0 24 24" class={className} aria-hidden="true">
	<path
		fill="currentColor"
		fill-rule="evenodd"
		d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9ZM12.65 12.1L12.65 9L11.35 9L11.35 12.1ZM13.19 13.16L15.88 11.61L15.23 10.49L12.54 12.04ZM12.54 14.16L15.23 15.71L15.88 14.59L13.19 13.04ZM11.35 14.1L11.35 17.2L12.65 17.2L12.65 14.1ZM10.81 13.04L8.12 14.59L8.77 15.71L11.46 14.16ZM11.46 12.04L8.77 10.49L8.12 11.61L10.81 13.16Z"
	/>
</svg>
