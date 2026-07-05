<script lang="ts">
	import './layout.css';
	import { ModeWatcher, mode } from 'mode-watcher';
	import { Toaster } from 'svelte-sonner';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- Respects prefers-color-scheme by default; persists an explicit override. -->
<ModeWatcher />
<Toaster theme={mode.current} position="bottom-right" richColors />

{@render children()}
