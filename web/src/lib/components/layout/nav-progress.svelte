<script lang="ts">
	import { navigating } from '$app/state';

	// Loads block navigation until their data arrives, so a slow one would
	// otherwise leave the old page up with no sign anything is happening.
	// Shown only past a short delay, so fast navigations don't flash it.
	let visible = $state(false);
	$effect(() => {
		if (!navigating.to) {
			visible = false;
			return;
		}
		const timer = setTimeout(() => (visible = true), 150);
		return () => clearTimeout(timer);
	});
</script>

{#if visible}
	<div
		role="progressbar"
		aria-label="Loading page"
		class="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/15"
	>
		<div class="bar h-full w-1/3 bg-primary"></div>
	</div>
{/if}

<style>
	.bar {
		animation: slide 1.1s ease-in-out infinite;
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
			width: 100%;
			opacity: 0.6;
		}
	}
</style>
