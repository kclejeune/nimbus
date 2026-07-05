<script lang="ts">
	import { tickIndices } from '$lib/chart-ticks';

	interface Point {
		label: string;
		value: number;
		/** Per-period change at this point, surfaced on hover. */
		delta?: number;
	}

	let {
		points,
		format = (v: number) => String(v),
		deltaFormat = (v: number) => String(v),
		deltaLabel = '',
		ariaLabel = 'Cumulative over time'
	}: {
		points: Point[];
		format?: (v: number) => string;
		deltaFormat?: (v: number) => string;
		deltaLabel?: string;
		ariaLabel?: string;
	} = $props();

	// Fixed drawing coordinates; the SVG scales to the container via CSS.
	const W = 720,
		H = 220,
		padL = 58,
		padR = 14,
		padT = 14,
		padB = 30;
	const innerW = W - padL - padR;
	const innerH = H - padT - padB;

	const max = $derived(Math.max(1, ...points.map((p) => p.value)));
	const xAt = (i: number) =>
		padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
	const yAt = (v: number) => padT + innerH - (v / max) * innerH;

	const linePath = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(p.value)}`).join(' '));
	const areaPath = $derived(
		points.length
			? `${linePath} L${xAt(points.length - 1)},${padT + innerH} L${xAt(0)},${padT + innerH} Z`
			: ''
	);

	const ticks = $derived([0, 0.5, 1].map((f) => ({ v: f * max, y: yAt(f * max) })));
	const xLabels = $derived(
		tickIndices(
			points.map((p) => p.label),
			7
		).map((i) => ({ x: xAt(i), label: points[i].label }))
	);

	let hovered = $state<number | null>(null);
	let plot = $state<SVGRectElement | null>(null);

	function onMove(e: PointerEvent) {
		if (!plot || points.length === 0) return;
		const rect = plot.getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		hovered = Math.round(frac * (points.length - 1));
	}
</script>

<div class="relative">
	<svg viewBox="0 0 {W} {H}" class="w-full" role="img" aria-label={ariaLabel}>
		<!-- gridlines + y labels -->
		{#each ticks as t (t.v)}
			<line x1={padL} x2={W - padR} y1={t.y} y2={t.y} class="stroke-border" stroke-width="1" />
			<text x={padL - 8} y={t.y + 4} text-anchor="end" class="fill-muted-foreground text-[11px]">
				{format(t.v)}
			</text>
		{/each}

		{#if areaPath}
			<path d={areaPath} class="fill-primary/12" />
			<path d={linePath} class="stroke-primary" stroke-width="2" fill="none" stroke-linejoin="round" />
		{/if}

		{#each xLabels as l (l.x)}
			<text x={l.x} y={H - 10} text-anchor="middle" class="fill-muted-foreground text-[11px]">
				{l.label}
			</text>
		{/each}

		{#if hovered !== null && points[hovered]}
			<line
				x1={xAt(hovered)}
				x2={xAt(hovered)}
				y1={padT}
				y2={padT + innerH}
				class="stroke-muted-foreground/50"
				stroke-width="1"
			/>
			<circle cx={xAt(hovered)} cy={yAt(points[hovered].value)} r="4" class="fill-primary" />
			<circle
				cx={xAt(hovered)}
				cy={yAt(points[hovered].value)}
				r="7"
				class="fill-primary/20"
			/>
		{/if}

		<!-- hover capture -->
		<rect
			bind:this={plot}
			x={padL}
			y={padT}
			width={innerW}
			height={innerH}
			fill="transparent"
			role="presentation"
			onpointermove={onMove}
			onpointerleave={() => (hovered = null)}
		/>
	</svg>

	{#if hovered !== null && points[hovered]}
		{@const frac = points.length <= 1 ? 0.5 : hovered / (points.length - 1)}
		<div
			class="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
			style="left: calc({padL / W * 100}% + {frac} * (100% - {(padL + padR) / W * 100}%))"
		>
			<div class="font-medium">{format(points[hovered].value)}</div>
			{#if points[hovered].delta}
				<div class="text-primary">+{deltaFormat(points[hovered].delta ?? 0)} {deltaLabel}</div>
			{/if}
			<div class="text-muted-foreground">{points[hovered].label}</div>
		</div>
	{/if}
</div>
