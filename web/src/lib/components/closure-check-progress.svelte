<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Check, Circle, LoaderCircle, Pause } from '@lucide/svelte';
	import { enhance, deserialize, applyAction } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { formatCount, formatRelativeTime } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import type { ClosureCheck } from '$lib/server/maintenance-ui';
	let {
		caches,
		check = null,
		allowAll = false
	}: {
		caches: { id: number; name: string }[];
		check?: ClosureCheck | null;
		allowAll?: boolean;
	} = $props();
	let current = $state<ClosureCheck | null>(untrack(() => check));
	let scope = $state(untrack(() => (allowAll ? '*' : (caches[0]?.name ?? ''))));
	let sending = $state(false);
	let looping = false;
	let stopped = false;
	let mounted = $state(false);
	$effect(() => {
		const incoming = check;
		untrack(() => {
			if (
				incoming &&
				(!current ||
					incoming.startedAt > current.startedAt ||
					(incoming.id === current.id && incoming.updatedAt >= current.updatedAt))
			)
				current = incoming;
		});
	});
	$effect(() => {
		if (mounted && current?.state === 'running' && !sending) void advance();
	});
	onMount(() => {
		mounted = true;
		return () => {
			stopped = true;
		};
	});
	async function advance() {
		if (looping || stopped || !current) return;
		looping = true;
		try {
			while (!stopped && current?.state === 'running') {
				await new Promise((r) => setTimeout(r, 1000));
				if (stopped || current.state !== 'running') break;
				const body = new FormData();
				body.set('id', current.id);
				const response = await fetch('?/continueClosureCheck', {
					method: 'POST',
					body,
					headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
				});
				const result = deserialize(await response.text());
				if (result.type !== 'success' || !result.data?.closureCheck)
					throw new Error('The check is paused. Your progress is saved; resume shortly.');
				current = result.data.closureCheck as ClosureCheck;
				await applyAction(result);
			}
		} catch {
			if (current)
				current = {
					...current,
					state: 'paused',
					message: 'The service is busy. Your progress is saved; resume shortly.'
				};
		} finally {
			looping = false;
		}
	}
	const completed = $derived(
		current?.caches.filter((cache) => cache.state === 'complete').length ?? 0
	);
</script>

<form
	method="POST"
	action="?/startClosureCheck"
	class="flex flex-wrap items-end gap-3"
	use:enhance={toastErrors(() => {
		sending = true;
		return async ({ result, update }) => {
			try {
				await update({ reset: false, invalidateAll: false });
				if (result.type === 'success' && result.data?.closureCheck)
					current = result.data.closureCheck as ClosureCheck;
			} finally {
				sending = false;
			}
		};
	})}
>
	<div class="min-w-40 space-y-1.5">
		<Label for="closure-cache">Caches to check</Label>
		<select
			id="closure-cache"
			name="cache"
			class="native-select w-full"
			bind:value={scope}
			disabled={sending || current?.state === 'running'}
		>
			{#if allowAll}<option value="*">All caches</option>{/if}
			{#each caches as cache (cache.id)}<option value={cache.name}>{cache.name}</option>{/each}
		</select>
	</div>
	<Button
		type="submit"
		variant="outline"
		size="sm"
		disabled={sending || current?.state === 'running' || !caches.length}
		>{sending ? 'Starting…' : 'Check dependencies'}</Button
	>
</form>
<p class="text-xs text-muted-foreground">
	Checking never removes paths. Checks advance while this page is open; progress survives refreshes
	and can be resumed.
</p>
{#if current}
	<div class="space-y-4 rounded-lg border p-4 text-sm">
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div role="status" aria-live="polite">
				<p class="font-medium">
					{current.state === 'complete'
						? 'Check complete'
						: current.state === 'paused'
							? 'Check paused'
							: 'Checking dependencies'} · {current.scope === '*' ? 'All caches' : current.scope}
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{completed} of {current.caches.length} caches complete
				</p>
			</div>
			<p class="text-xs text-muted-foreground">Updated {formatRelativeTime(current.updatedAt)}</p>
		</div>
		{#if current.message}<p role="status" class="text-warning">{current.message}</p>{/if}
		<ul class="space-y-2">
			{#each current.caches as cache, index (cache.id)}
				{@const complete = cache.state === 'complete'}
				{@const active = !complete && index === current.index}
				{@const running = active && current.state === 'running'}
				<li
					class={'flex flex-wrap items-center gap-3 rounded-md border px-3 py-3' +
						(active ? ' bg-primary/5' : '')}
				>
					<div
						class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"
						class:text-primary={active || complete}
						class:text-muted-foreground={!active && !complete}
					>
						{#if complete}
							<Check class="size-4" aria-hidden="true" />
						{:else if running}
							<LoaderCircle class="size-4 motion-safe:animate-spin" aria-hidden="true" />
						{:else if active}
							<Pause class="size-4" aria-hidden="true" />
						{:else}
							<Circle class="size-3" aria-hidden="true" />
						{/if}
					</div>
					<div class="min-w-0 flex-1 space-y-2">
						<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<strong class="font-medium break-all">{cache.name}</strong>
							<span class="text-xs text-muted-foreground">
								{#if cache.missing || cache.unverified}
									<span class="text-warning"
										>{formatCount(cache.missing)} missing, {formatCount(cache.unverified)} unverified</span
									>
								{:else if complete}
									No missing dependencies
								{:else if active}
									{current.state === 'paused' ? 'Paused · progress saved' : 'Checking references'}
								{/if}
							</span>
						</div>
						<div
							role="progressbar"
							aria-label={`${cache.name} dependency check`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={complete ? 100 : active ? undefined : 0}
							aria-valuetext={complete
								? 'Complete'
								: running
									? 'Checking references'
									: active
										? 'Paused'
										: 'Queued'}
							class="h-1 overflow-hidden rounded-full bg-muted"
						>
							{#if complete}
								<div class="h-full w-full rounded-full bg-primary/60"></div>
							{:else if running}
								<div class="checking h-full w-1/3 rounded-full bg-primary"></div>
							{/if}
						</div>
					</div>
					{#if cache.firstFinding !== undefined && current.state !== 'running'}
						<form method="POST" action="?/inspectClosures" use:enhance={toastErrors()}>
							<input type="hidden" name="cache" value={cache.name} /><input
								type="hidden"
								name="after"
								value={cache.firstFinding}
							/>
							<Button type="submit" variant="outline" size="sm">Review {cache.name}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
		{#if current.state !== 'complete'}
			<form
				method="POST"
				action={current.state === 'paused' ? '?/continueClosureCheck' : '?/pauseClosureCheck'}
				use:enhance={toastErrors(() => async ({ result, update }) => {
					await update({ reset: false, invalidateAll: false });
					if (result.type === 'success' && result.data?.closureCheck)
						current = result.data.closureCheck as ClosureCheck;
				})}
			>
				<input type="hidden" name="id" value={current.id} />
				<Button type="submit" variant="outline" size="sm"
					>{current.state === 'paused' ? 'Resume check' : 'Pause check'}</Button
				>
			</form>
		{/if}
	</div>
{/if}

<style>
	.checking {
		animation: scan 1.6s ease-in-out infinite;
	}
	@keyframes scan {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.checking {
			animation: none;
			width: 100%;
			opacity: 0.6;
		}
	}
</style>
