<script lang="ts">
	import { formatBytes, formatCount, formatIsoDateTime, shortStorePath } from '$lib/format';
	import StorePathTable from '$lib/components/store-path-table.svelte';
	import CopyField from '$lib/components/copy-field.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ChevronDown, ChevronUp, Pin } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';
	import SearchInput from '$lib/components/layout/search-input.svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';

	let { data } = $props();
	const o = $derived(data.object);
	const nar = $derived(data.nar);

	/** Human name of a store path (part after /nix/store/<hash>-). */
	function pathName(path: string): string {
		const base = path.replace(/^\/nix\/store\//, '');
		const dash = base.indexOf('-');
		return dash >= 0 ? base.slice(dash + 1) : base;
	}

	// RFC3339 timestamp → "YYYY-MM-DD HH:MM" (UTC), matching the app's style.

	// Chunk-table controls: client-side filter/sort/pagination (the rows are
	// already fully loaded; MAX_NAR_CHUNKS bounds them at 2000).
	const CHUNK_PAGE = 25;
	type ChunkSortKey = 'seq' | 'hash' | 'size' | 'stored' | 'codec' | 'dedup';
	let chunkQ = $state('');
	let chunkSort = $state<ChunkSortKey>('seq');
	let chunkAsc = $state(true);
	let chunkPage = $state(1);
	type ChunkRow = (typeof data.chunks)[number];
	function chunkKey(c: ChunkRow, key: ChunkSortKey): string | number | null {
		switch (key) {
			case 'seq':
				return c.seq;
			case 'hash':
				return c.chunkHash;
			case 'size':
				return c.chunkSize;
			case 'stored':
				return c.fileSize;
			case 'codec':
				return c.compression;
			case 'dedup':
				return c.sharedNars;
		}
	}
	const chunksFiltered = $derived.by(() => {
		const term = chunkQ.trim().toLowerCase();
		if (!term) return data.chunks;
		return data.chunks.filter((c) => c.chunkHash.toLowerCase().includes(term));
	});
	const chunksSorted = $derived.by(() => {
		const flip = chunkAsc ? 1 : -1;
		return [...chunksFiltered].sort((a, b) => {
			const va = chunkKey(a, chunkSort);
			const vb = chunkKey(b, chunkSort);
			if (va === null && vb === null) return 0;
			if (va === null) return 1;
			if (vb === null) return -1;
			const cmp =
				typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb));
			return cmp * flip;
		});
	});
	const chunkPages = $derived(Math.max(1, Math.ceil(chunksSorted.length / CHUNK_PAGE)));
	const chunkCurrent = $derived(Math.min(chunkPage, chunkPages));
	const chunksPaged = $derived(
		chunksSorted.slice((chunkCurrent - 1) * CHUNK_PAGE, chunkCurrent * CHUNK_PAGE)
	);
	function toggleChunkSort(key: ChunkSortKey) {
		if (chunkSort === key) {
			chunkAsc = !chunkAsc;
		} else {
			chunkSort = key;
			chunkAsc = true;
		}
		chunkPage = 1;
	}

	const isPinned = $derived(data.pins.anonymous !== null || data.pins.named.length > 0);
	const cacheHref = $derived(`/caches/${encodeURIComponent(data.cache.name)}`);
	// The 32-char store hash, shown muted beside the name.
	const storeHash = $derived(/^\/nix\/store\/([0-9a-z]{32})-/.exec(o.storePath)?.[1] ?? '');
</script>

{#snippet chunkHeader(key: ChunkSortKey, label: string)}
	<button
		type="button"
		class="inline-flex items-center gap-1 font-medium transition-colors hover:text-foreground {chunkSort ===
		key
			? 'text-foreground'
			: ''}"
		onclick={() => toggleChunkSort(key)}
		aria-label="Sort by {label}"
	>
		{label}
		{#if chunkSort === key}
			{#if chunkAsc}<ChevronUp class="size-3" />{:else}<ChevronDown class="size-3" />{/if}
		{/if}
	</button>
{/snippet}

{#snippet sectionHeading(title: string, count: number, hint?: string)}
	<div class="mb-3">
		<h2 class="text-base font-semibold">
			{title}
			<span class="ml-1 font-normal text-muted-foreground tabular-nums">{formatCount(count)}</span>
		</h2>
		{#if hint}
			<p class="mt-0.5 text-sm text-muted-foreground">{hint}</p>
		{/if}
	</div>
{/snippet}

<Page>
	<header class="mb-8">
		<h1 class="font-mono text-2xl leading-tight font-semibold tracking-[-0.03em] break-all">
			{pathName(o.storePath)}
		</h1>
		{#if storeHash}
			<p class="mt-1 font-mono text-[0.8125rem] break-all text-muted-foreground" title="Store hash">
				{storeHash}
			</p>
		{/if}
		<div class="mt-3 flex flex-wrap items-center gap-2">
			{#if o.system}
				<StatusBadge>{o.system}</StatusBadge>
			{/if}
			<StatusBadge>{nar.compression}</StatusBadge>
			{#if o.detachedAt}
				<StatusBadge
					tone="danger"
					title="Removed {formatIsoDateTime(o.detachedAt)}; kept while other paths reference it"
				>
					Detached
				</StatusBadge>
			{/if}
			{#if isPinned}
				<StatusBadge tone="primary"><Pin class="size-3" /> Pinned</StatusBadge>
			{/if}
			{#if o.source}
				<StatusBadge>{o.source}</StatusBadge>
			{/if}
		</div>
		<div class="mt-4 max-w-3xl">
			<CopyField text={o.storePath} label="Copy store path" />
		</div>
	</header>

	<Panel title="Details" class="mb-10">
		<dl class="grid gap-x-10 gap-y-4 text-sm sm:grid-cols-2">
			<div class="min-w-0">
				<dt class="text-xs font-medium text-muted-foreground">NAR hash</dt>
				<dd class="mt-1 font-mono text-[0.8125rem] break-all">{nar.narHash}</dd>
			</div>
			<div>
				<dt class="text-xs font-medium text-muted-foreground">NAR size</dt>
				<dd class="mt-1 font-mono text-[0.8125rem] tabular-nums">
					{formatBytes(nar.narSize)}
					<span class="font-sans text-muted-foreground">
						in {formatCount(nar.numChunks)} chunk{nar.numChunks === 1 ? '' : 's'}
					</span>
				</dd>
			</div>
			<div>
				<dt class="text-xs font-medium text-muted-foreground">Added</dt>
				<dd class="mt-1 font-mono text-[0.8125rem] tabular-nums">
					{formatIsoDateTime(o.createdAt)}
				</dd>
			</div>
			<div>
				<dt class="text-xs font-medium text-muted-foreground">Last accessed</dt>
				<dd class="mt-1 font-mono text-[0.8125rem] tabular-nums">
					{formatIsoDateTime(o.lastAccessedAt)}
				</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs font-medium text-muted-foreground">Deriver</dt>
				<dd class="mt-1 font-mono text-[0.8125rem] break-all">
					{#if o.deriver}{o.deriver}{:else}<span class="text-muted-foreground">None</span>{/if}
				</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs font-medium text-muted-foreground">Content address</dt>
				<dd class="mt-1 font-mono text-[0.8125rem] break-all">
					{#if o.ca}{o.ca}{:else}<span class="text-muted-foreground">None</span>{/if}
				</dd>
			</div>
			<div>
				<dt class="text-xs font-medium text-muted-foreground">Pushed by</dt>
				<dd class="mt-1 font-mono text-[0.8125rem]">
					{#if o.createdBy}{o.createdBy}{:else}<span class="text-muted-foreground">Unknown</span
						>{/if}
				</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs font-medium text-muted-foreground">Signatures</dt>
				<dd class="mt-1">
					{#if o.sigs.length === 0}
						<span class="text-muted-foreground">None</span>
					{:else}
						<ul class="space-y-1">
							{#each o.sigs as sig (sig)}
								<li class="font-mono text-[0.8125rem] break-all">{sig}</li>
							{/each}
						</ul>
					{/if}
				</dd>
			</div>
		</dl>

		{#if isPinned}
			<div class="mt-5 border-t pt-4">
				<h3 class="text-xs font-medium text-muted-foreground">Pins</h3>
				<ul class="mt-2 space-y-1.5 text-sm">
					{#if data.pins.anonymous}
						<li class="flex flex-wrap items-center gap-2">
							<Pin class="size-3.5 text-primary" />
							<span>Pinned {formatIsoDateTime(data.pins.anonymous.createdAt)}</span>
							{#if data.pins.anonymous.note}
								<span class="text-muted-foreground">{data.pins.anonymous.note}</span>
							{/if}
						</li>
					{/if}
					{#each data.pins.named as pin (pin.name)}
						<li class="flex flex-wrap items-center gap-2">
							<Pin class="size-3.5 text-primary" />
							<code class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs"
								>{pin.name}</code
							>
							<span class="text-muted-foreground"
								>Revision from {formatIsoDateTime(pin.createdAt)}</span
							>
							{#if pin.note}
								<span class="text-muted-foreground">{pin.note}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</Panel>

	<section class="mb-10">
		{@render sectionHeading(
			'References',
			data.references.length,
			'Paths this store path depends on.'
		)}
		{#if data.references.length === 0}
			<EmptyState
				title="No references"
				description="This path doesn't depend on any other store path."
			/>
		{:else}
			<StorePathTable
				interactive
				rows={data.references.map((ref) => {
					if (ref.storePath) {
						return {
							href: `${cacheHref}/paths/${ref.hash}`,
							storePath: ref.storePath,
							hash: ref.hash,
							createdAt: ref.createdAt,
							narSize: ref.narSize
						};
					}
					// Not in this cache — say where it actually lives when known:
					// another browsable cache (linked) or a cached upstream verdict.
					if (ref.elsewhere?.kind === 'cache') {
						return {
							href: `/caches/${encodeURIComponent(ref.elsewhere.cache)}/paths/${ref.hash}`,
							storePath: ref.elsewhere.storePath,
							hash: ref.hash,
							createdAt: ref.elsewhere.createdAt,
							narSize: ref.elsewhere.narSize,
							note: `in ${ref.elsewhere.cache}`
						};
					}
					return {
						href: null,
						storePath: null,
						hash: ref.hash,
						createdAt: null,
						narSize: null,
						note:
							ref.elsewhere?.kind === 'upstream'
								? `Available from ${ref.elsewhere.host}`
								: undefined
					};
				})}
			/>
		{/if}
	</section>

	<section class="mb-10">
		{@render sectionHeading(
			'Referrers',
			data.referrers.total,
			'Paths in this cache that depend on this store path.'
		)}
		{#if data.referrers.rows.length === 0}
			<EmptyState title="No referrers" description="Nothing in this cache depends on this path." />
		{:else}
			<StorePathTable
				interactive
				rows={data.referrers.rows.map((referrer) => ({
					href: `${cacheHref}/paths/${referrer.hash}`,
					storePath: referrer.storePath,
					hash: referrer.hash,
					createdAt: referrer.createdAt,
					narSize: referrer.narSize
				}))}
			/>
			{#if data.referrers.total > data.referrers.rows.length}
				<p class="mt-2 text-xs text-muted-foreground tabular-nums">
					And {formatCount(data.referrers.total - data.referrers.rows.length)} more not shown.
				</p>
			{/if}
		{/if}
	</section>

	<section>
		{@render sectionHeading(
			'Chunks',
			data.chunks.length,
			'How this NAR is split in storage, and which chunks other NARs share.'
		)}
		{#if data.chunks.length === 0}
			<EmptyState title="No chunks recorded" description="This NAR has no chunk records." />
		{:else}
			{#if data.chunks.length > CHUNK_PAGE || chunkQ}
				<SearchInput
					class="mb-3"
					placeholder="Filter by hash"
					bind:value={chunkQ}
					oninput={() => (chunkPage = 1)}
				/>
			{/if}
			<div class="table-frame">
				<table class="data-table">
					<thead>
						<tr>
							<th class="w-14">{@render chunkHeader('seq', '#')}</th>
							<th>{@render chunkHeader('hash', 'Chunk hash')}</th>
							<th class="num w-28">{@render chunkHeader('size', 'Size')}</th>
							<th class="num w-28">{@render chunkHeader('stored', 'Stored')}</th>
							<th class="w-24">{@render chunkHeader('codec', 'Codec')}</th>
							<th class="w-52">{@render chunkHeader('dedup', 'Dedup')}</th>
						</tr>
					</thead>
					<tbody>
						{#each chunksPaged as chunk (chunk.seq)}
							<tr>
								<td class="font-mono text-[0.8125rem] text-muted-foreground tabular-nums"
									>{chunk.seq}</td
								>
								<td class="font-mono text-xs break-all">{chunk.chunkHash}</td>
								<td class="num">
									{chunk.chunkSize != null ? formatBytes(chunk.chunkSize) : '—'}
								</td>
								<td class="num">
									{chunk.fileSize != null ? formatBytes(chunk.fileSize) : '—'}
								</td>
								<td class="font-mono text-[0.8125rem] text-muted-foreground">{chunk.compression}</td
								>
								<td>
									{#if chunk.sharedNars > 0}
										<StatusBadge tone="success">
											Shared with {formatCount(chunk.sharedNars)}
											{chunk.sharedNars === 1 ? 'NAR' : 'NARs'}
										</StatusBadge>
									{:else}
										<span class="text-xs text-muted-foreground">Unique to this NAR</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				{#if chunksPaged.length === 0}
					<p class="py-8 text-center text-sm text-muted-foreground">
						No chunks match “{chunkQ}”.
					</p>
				{/if}
			</div>

			{#if chunksSorted.length > CHUNK_PAGE}
				<div class="mt-3 flex flex-wrap items-center justify-between gap-3">
					<p class="text-xs text-muted-foreground tabular-nums">
						Showing {formatCount((chunkCurrent - 1) * CHUNK_PAGE + 1)}–{formatCount(
							(chunkCurrent - 1) * CHUNK_PAGE + chunksPaged.length
						)} of {formatCount(chunksSorted.length)}
					</p>
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={chunkCurrent <= 1}
							onclick={() => (chunkPage = chunkCurrent - 1)}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={chunkCurrent >= chunkPages}
							onclick={() => (chunkPage = chunkCurrent + 1)}
						>
							Next
						</Button>
					</div>
				</div>
			{/if}
		{/if}
	</section>
</Page>
