<script lang="ts">
	let { class: className = '' }: { class?: string } = $props();
	// Gradient ids must be unique per instance — the logo can render more than
	// once on a page (sidebar + login card).
	const uid = $props.id();
</script>

<!-- The nimbus mark: a gradient cloud (app-icon style: darker outer rim with an
     inset inner panel) carrying the Nix snowflake in white. The silhouette was
     least-squares-fitted to the reference art: a stadium base (very round
     corners), a small left lobe (the only crease), and one big dome whose right
     side flows straight into the base — no separate right lobe. The small
     fourth circle is a fillet bridging the dome/base junction so the right
     shoulder stays smooth. Each layer is a union of clockwise subpaths (nonzero
     fill unions them; mixed winding would carve holes), and the inner layer's
     circles shrink less than the band inset so no gap opens at the junctions.
     Fixed palette (not currentColor), like a brand mark — it reads the same on
     light and dark surfaces. -->
<svg viewBox="0 0 24 24" class={className} aria-hidden="true">
	<!-- Dark mode brightens the stops a touch: the light-mode rim bottom
	     (#4747a8) melts into near-black surfaces, so the edge needs a bit more
	     luminance to stay crisp there. stop-color is a presentation attribute,
	     so the dark: class overrides win. -->
	<defs>
		<linearGradient id="outer-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" class="[stop-color:#5b8cd7] dark:[stop-color:#699ae2]" />
			<stop offset="1" class="[stop-color:#4747a8] dark:[stop-color:#5457c0]" />
		</linearGradient>
		<linearGradient id="inner-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" class="[stop-color:#74aaec] dark:[stop-color:#81b3f2]" />
			<stop offset="0.55" class="[stop-color:#5f74d2] dark:[stop-color:#6c80de]" />
			<stop offset="1" class="[stop-color:#5a57c2] dark:[stop-color:#6663d0]" />
		</linearGradient>
	</defs>
	<path
		fill="url(#outer-{uid})"
		d="M6 9.5 H18 a4.8 4.8 0 0 1 4.8 4.8 a4.8 4.8 0 0 1 -4.8 4.8 H6 a4.8 4.8 0 0 1 -4.8 -4.8 a4.8 4.8 0 0 1 4.8 -4.8 Z M3.28 11.04 a3.26 3.26 0 1 1 6.52 0 a3.26 3.26 0 1 1 -6.52 0 Z M5.97 12.09 a6.74 6.74 0 1 1 13.48 0 a6.74 6.74 0 1 1 -13.48 0 Z M16.3 11.4 a2.3 2.3 0 1 1 4.6 0 a2.3 2.3 0 1 1 -4.6 0 Z"
	/>
	<path
		fill="url(#inner-{uid})"
		d="M6.07 10.06 H17.93 a4.17 4.17 0 0 1 4.17 4.17 a4.17 4.17 0 0 1 -4.17 4.17 H6.07 a4.17 4.17 0 0 1 -4.17 -4.17 a4.17 4.17 0 0 1 4.17 -4.17 Z M3.88 11.25 a2.67 2.67 0 1 1 5.33 0 a2.67 2.67 0 1 1 -5.33 0 Z M6.67 12.3 a6.04 6.04 0 1 1 12.08 0 a6.04 6.04 0 1 1 -12.08 0 Z M16.72 11.61 a1.88 1.88 0 1 1 3.76 0 a1.88 1.88 0 1 1 -3.76 0 Z"
	/>
	<!-- Nix snowflake (Simple Icons "NixOS", CC0), centered in the dome. -->
	<path
		transform="translate(7.6 8) scale(0.4)"
		fill="#f2f7fe"
		d="M7.352 1.592l-1.364.002L5.32 2.75l1.557 2.713-3.137-.008-1.32 2.34H14.11l-1.353-2.332-3.192-.006-2.214-3.865zm6.175 0l-2.687.025 5.846 10.127 1.341-2.34-1.59-2.765 2.24-3.85-.683-1.182h-1.336l-1.57 2.705-1.56-2.72zm6.887 4.195l-5.846 10.125 2.696-.008 1.601-2.76 4.453.016.682-1.183-.666-1.157-3.13-.008L21.778 8.1l-1.365-2.313zM9.432 8.086l-2.696.008-1.601 2.76-4.453-.016L0 12.02l.666 1.157 3.13.008-1.575 2.71 1.365 2.315L9.432 8.086zM7.33 12.25l-.006.01-.002-.004-1.342 2.34 1.59 2.765-2.24 3.85.684 1.182H7.35l.004-.006h.001l1.567-2.698 1.558 2.72 2.688-.026-.004-.006h.01L7.33 12.25zm2.55 3.93l1.354 2.332 3.192.006 2.215 3.865 1.363-.002.668-1.156-1.557-2.713 3.137.008 1.32-2.34H9.881Z"
	/>
</svg>
