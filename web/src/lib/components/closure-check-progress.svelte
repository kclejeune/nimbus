<script lang="ts">
	import { onMount, untrack } from 'svelte';
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
	const totals = $derived(
		current?.caches.reduce(
			(n, c) => ({
				scanned: n.scanned + c.scanned,
				checked: n.checked + c.checked,
				missing: n.missing + c.missing,
				unverified: n.unverified + c.unverified
			}),
			{ scanned: 0, checked: 0, missing: 0, unverified: 0 }
		)
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
{#if current && totals}
	<div class="space-y-3 rounded-lg border p-4 text-sm" aria-live="polite">
		<p class="font-medium">
			{current.state === 'complete'
				? 'Check complete'
				: current.state === 'paused'
					? 'Check paused'
					: 'Checking dependencies'} · {current.scope === '*' ? 'All caches' : current.scope}
		</p>
		<p class="text-muted-foreground">
			{current.caches.filter((c) => c.state === 'complete').length} of {current.caches.length} caches
			complete. Scanned {formatCount(totals.scanned)} hashes and checked {formatCount(
				totals.checked
			)} dependencies. Updated {formatRelativeTime(current.updatedAt)}.
		</p>
		{#if current.message}<p role="status" class="text-warning">{current.message}</p>{/if}
		<ul class="space-y-2">
			{#each current.caches as cache (cache.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
					<span
						><strong>{cache.name}</strong> · {cache.state === 'complete'
							? 'Complete'
							: cache.state === 'checking'
								? 'In progress'
								: 'Waiting'} · {formatCount(cache.missing)} missing, {formatCount(cache.unverified)} unverified</span
					>
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
