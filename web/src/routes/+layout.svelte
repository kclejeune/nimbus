<script lang="ts">
	import './layout.css';
	import { ModeWatcher, mode } from 'mode-watcher';
	import { Toaster } from 'svelte-sonner';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<title>nimbus</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- CSS follows prefers-color-scheme on its own; the .light class lets a persisted
     explicit override beat the media query (see layout.css). -->
<ModeWatcher lightClassNames={['light']} />
<Toaster theme={mode.current} position="bottom-right" richColors />

{@render children()}
