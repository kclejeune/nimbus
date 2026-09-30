<script lang="ts" module>
	export interface Series {
		key: string;
		label: string;
		/** A CSS color, normally a --viz-* role. */
		color: string;
		/** null = no data in that bucket: lines break there instead of dropping to zero. */
		values: (number | null)[];
	}

	const DAY_FMT = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	const TIME_FMT = new Intl.DateTimeFormat('en-US', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: 'UTC'
	});
	const dayLabel = (iso: string) => DAY_FMT.format(new Date(iso));
	const timeLabel = (iso: string) => TIME_FMT.format(new Date(iso));
</script>

<script lang="ts">
	import { tickIndices } from '$lib/chart-ticks';

	let {
		t,
		series,
		kind = 'line',
		format = (v: number) => String(Math.round(v)),
		stepSeconds,
		yMax,
		scale = 'linear',
		height = 200,
		ariaLabel
	}: {
		/** Bucket starts, ISO. */
		t: string[];
		series: Series[];
		/** `line` for independent measures; `stacked` for parts of a whole. */
		kind?: 'line' | 'stacked';
		format?: (v: number) => string;
		/** Bucket width, to label the x axis in hours or days. */
		stepSeconds: number;
		/** Fixed ceiling (e.g. 1 for ratios); otherwise a clean number above the data. */
		yMax?: number;
		/** `log` for measures spanning orders of magnitude (latency percentiles):
		 *  a tail spike no longer flattens the typical values against zero. */
		scale?: 'linear' | 'log';
		height?: number;
		ariaLabel: string;
	} = $props();

	// Drawn at the container's real width so axis text stays 10.5px instead of
	// shrinking with a fixed viewBox in narrow panels. 720 until measured (SSR).
	let measured = $state(0);
	const W = $derived(measured || 720);
	const padL = 60,
		padR = 12,
		padT = 12,
		padB = 26;
	const H = $derived(height);
	const innerW = $derived(W - padL - padR);
	const innerH = $derived(H - padT - padB);

	// Stacked series accumulate bottom-up in legend order.
	const stacks = $derived.by(() => {
		if (kind !== 'stacked') return series.map((s) => s.values.map((v) => [0, v] as const));
		const base = t.map(() => 0);
		return series.map((s) =>
			s.values.map((v, i) => {
				const lo = base[i];
				base[i] += v ?? 0;
				return [lo, base[i]] as const;
			})
		);
	});

	/** Round a maximum up to 1, 2 or 5 × 10^n so ticks land on clean values. */
	function niceCeil(v: number): number {
		if (v <= 0) return 1;
		const pow = 10 ** Math.floor(Math.log10(v));
		const f = v / pow;
		return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
	}
	const max = $derived(
		yMax ?? niceCeil(Math.max(0, ...stacks.flatMap((s) => s.map(([, hi]) => hi ?? 0))))
	);
	const xAt = (i: number) => padL + (t.length <= 1 ? innerW / 2 : (i / (t.length - 1)) * innerW);
	// Log domain: whole decades around the data (values <= 0 aren't plottable).
	const logDomain = $derived.by(() => {
		const vals = series.flatMap((s) => s.values).filter((v): v is number => v !== null && v > 0);
		if (!vals.length) return [1, 10] as const;
		const lo = 10 ** Math.floor(Math.log10(Math.min(...vals)));
		const hi = 10 ** Math.ceil(Math.log10(Math.max(...vals)));
		return [lo, hi === lo ? lo * 10 : hi] as const;
	});
	const yAt = (v: number) => {
		if (scale === 'log') {
			const [lo, hi] = logDomain;
			const f = (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
			return padT + innerH - Math.min(1, f) * innerH;
		}
		return padT + innerH - (Math.min(v, max) / max) * innerH;
	};

	const ticks = $derived.by(() => {
		if (scale !== 'log') {
			// A 5×10^n ceiling divides evenly into fifths; 1s and 2s into quarters.
			const mantissa = Math.round(max / 10 ** Math.floor(Math.log10(max)));
			const parts = mantissa === 5 ? 5 : 4;
			return Array.from({ length: parts + 1 }, (_, i) => {
				const v = (max * i) / parts;
				return { v, y: yAt(v) };
			});
		}
		const [lo, hi] = logDomain;
		const out: { v: number; y: number }[] = [];
		for (let v = lo; v <= hi * 1.0001; v *= 10) out.push({ v, y: yAt(v) });
		return out;
	});

	const xLabel = (iso: string) => (stepSeconds >= 3600 ? dayLabel(iso) : timeLabel(iso));
	const fullLabel = (iso: string) =>
		stepSeconds >= 86400 ? dayLabel(iso) : `${dayLabel(iso)}, ${timeLabel(iso)} UTC`;
	// Formatted once per data change, not again on every resize (xAt tracks width).
	const labels = $derived(t.map(xLabel));
	const xTicks = $derived(tickIndices(labels, 6).map((i) => ({ x: xAt(i), label: labels[i] })));

	type Pt = readonly [number, number | null];
	// A null starts a new subpath, so gaps render as gaps.
	const linePath = (pts: readonly Pt[]) => {
		let pen = false;
		return pts
			.map(([, hi], i) => {
				if (hi === null || (scale === 'log' && hi <= 0)) {
					pen = false;
					return '';
				}
				const cmd = pen ? 'L' : 'M';
				pen = true;
				return `${cmd}${xAt(i).toFixed(1)},${yAt(hi).toFixed(1)}`;
			})
			.join('');
	};
	const bandPath = (raw: readonly Pt[]) => {
		const pts = raw.map(([lo, hi]) => [lo, hi ?? 0] as const);
		if (!pts.length) return '';
		const top = pts.map(
			([, hi], i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(hi).toFixed(1)}`
		);
		const bottom = pts.map(([lo], i) => `L${xAt(i).toFixed(1)},${yAt(lo).toFixed(1)}`).reverse();
		return `${top.join('')}${bottom.join('')}Z`;
	};

	let hovered = $state<number | null>(null);
	let plot = $state<SVGRectElement | null>(null);
	function onMove(e: PointerEvent) {
		if (!plot || t.length === 0) return;
		const rect = plot.getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		hovered = Math.round(frac * (t.length - 1));
	}
	// Keyboard parity with hover: arrow keys walk the buckets.
	function onKey(e: KeyboardEvent) {
		if (!t.length) return;
		if (e.key === 'ArrowRight') hovered = Math.min(t.length - 1, (hovered ?? -1) + 1);
		else if (e.key === 'ArrowLeft') hovered = Math.max(0, (hovered ?? t.length) - 1);
		else return;
		e.preventDefault();
	}
</script>

<div class="relative" bind:clientWidth={measured}>
	{#if series.length > 1}
		<ul class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			{#each series as s (s.key)}
				<li class="inline-flex items-center gap-1.5">
					<span
						class="inline-block {kind === 'stacked'
							? 'size-2.5 rounded-[3px]'
							: 'h-0.5 w-3 rounded-full'}"
						style="background: {s.color}"
						aria-hidden="true"
					></span>
					{s.label}
				</li>
			{/each}
		</ul>
	{/if}

	<!-- Focusable wrapper: arrow keys walk the buckets, same as hovering. Svelte
	     has no interactive role for a custom keyboard-driven widget; the
	     "Show data" table below is the fully accessible equivalent. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		role="application"
		aria-roledescription="chart"
		aria-label="{ariaLabel}. Left and right arrows step through values."
		tabindex="0"
		onkeydown={onKey}
		onblur={() => (hovered = null)}
		class="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
	>
		<svg viewBox="0 0 {W} {H}" class="w-full overflow-visible" role="img" aria-label={ariaLabel}>
			(hovered = null)} >
			{#each ticks as tick (tick.v)}
				<line
					x1={padL}
					x2={W - padR}
					y1={tick.y}
					y2={tick.y}
					class={tick.y >= padT + innerH - 0.5 ? 'stroke-border' : 'stroke-border/60'}
					stroke-width="1"
				/>
				<text
					x={padL - 8}
					y={tick.y + 3.5}
					text-anchor="end"
					class="fill-muted-foreground text-[10.5px] tabular-nums">{format(tick.v)}</text
				>
			{/each}

			{#if kind === 'stacked'}
				{#each series as s, si (s.key)}
					<!-- Surface-colored stroke is the 2px gap between stacked bands. -->
					<path
						d={bandPath(stacks[si])}
						style="fill: {s.color}"
						class="stroke-card"
						stroke-width="1.5"
						stroke-linejoin="round"
						opacity="0.9"
					/>
				{/each}
			{:else}
				{#each series as s, si (s.key)}
					{#if series.length === 1}
						<path d={bandPath(stacks[si])} style="fill: {s.color}" opacity="0.1" />
					{/if}
					<path
						d={linePath(stacks[si])}
						style="stroke: {s.color}"
						stroke-width="2"
						fill="none"
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				{/each}
			{/if}

			{#each xTicks as x (x.x)}
				<text x={x.x} y={H - 8} text-anchor="middle" class="fill-muted-foreground text-[10.5px]"
					>{x.label}</text
				>
			{/each}

			{#if hovered !== null}
				<line
					x1={xAt(hovered)}
					x2={xAt(hovered)}
					y1={padT}
					y2={padT + innerH}
					class="stroke-muted-foreground/50"
					stroke-width="1"
				/>
				{#each series as s, si (s.key)}
					{@const hi = stacks[si][hovered][1]}
					{#if hi !== null}
						<circle
							cx={xAt(hovered)}
							cy={yAt(hi)}
							r="4"
							style="fill: {s.color}"
							class="stroke-card"
							stroke-width="2"
						/>
					{/if}
				{/each}
			{/if}

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
	</div>

	{#if hovered !== null}
		{@const frac = t.length <= 1 ? 0.5 : hovered / (t.length - 1)}
		<div
			class="pointer-events-none absolute top-6 z-10 min-w-40 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-(--shadow-sheet) {frac >
			0.6
				? '-translate-x-[calc(100%+12px)]'
				: 'translate-x-3'}"
			style="left: calc({(padL / W) * 100}% + {frac} * {(innerW / W) * 100}%)"
		>
			<div class="mb-1.5 text-muted-foreground">{fullLabel(t[hovered])}</div>
			{#each [...series].reverse() as s (s.key)}
				<div class="flex items-center justify-between gap-4">
					<span class="inline-flex items-center gap-1.5">
						<span class="size-2 rounded-full" style="background: {s.color}"></span>{s.label}
					</span>
					<span class="font-medium tabular-nums"
						>{s.values[hovered] === null ? '—' : format(s.values[hovered]!)}</span
					>
				</div>
			{/each}
		</div>
	{/if}

	<!-- The table view: every value readable without hovering. -->
	<details class="mt-1 text-xs">
		<summary class="cursor-pointer text-muted-foreground select-none hover:text-foreground">
			Show data
		</summary>
		<div class="mt-2 max-h-56 overflow-auto rounded-md border">
			<table class="w-full text-xs">
				<thead class="sticky top-0 bg-subtle text-muted-foreground">
					<tr>
						<th class="px-2 py-1 text-left font-medium">Time</th>
						{#each series as s (s.key)}
							<th class="px-2 py-1 text-right font-medium">{s.label}</th>
						{/each}
					</tr>
				</thead>
				<tbody class="tabular-nums">
					{#each t as iso, i (iso)}
						<tr class="border-t border-border/60">
							<td class="px-2 py-1 text-muted-foreground">{fullLabel(iso)}</td>
							{#each series as s (s.key)}
								<td class="px-2 py-1 text-right"
									>{s.values[i] === null ? '—' : format(s.values[i]!)}</td
								>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
</div>
