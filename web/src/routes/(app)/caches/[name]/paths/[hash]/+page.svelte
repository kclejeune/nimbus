<script lang="ts">
	import { formatBytes, formatCount, formatIsoDateTime, shortStorePath } from '$lib/format';
	import StorePathTable from '$lib/components/store-path-table.svelte';
	import CopyField from '$lib/components/copy-field.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { ArrowLeft, Pin } from '@lucide/svelte';

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

	const isPinned = $derived(data.pins.anonymous !== null || data.pins.named.length > 0);
	const cacheHref = $derived(`/caches/${encodeURIComponent(data.cache.name)}`);
</script>

<div class="mx-auto max-w-6xl px-8 py-8">
	<a
		href={cacheHref}
		class="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" />
		{data.cache.name}
	</a>

	<header class="mb-8">
		<h1 class="font-mono text-2xl font-semibold tracking-tight break-all">
			{pathName(o.storePath)}
		</h1>
		<div class="mt-3 max-w-3xl">
			<CopyField text={o.storePath} label="Copy store path" />
		</div>
		<div class="mt-3 flex flex-wrap items-center gap-2">
			{#if o.system}
				<Badge variant="secondary">{o.system}</Badge>
			{/if}
			<Badge variant="secondary">{nar.compression}</Badge>
			{#if o.detachedAt}
				<Badge
					variant="destructive"
					title="Removed {formatIsoDateTime(o.detachedAt)}; kept while other paths reference it"
				>
					detached
				</Badge>
			{/if}
			{#if isPinned}
				<Badge variant="outline"><Pin class="size-3" /> pinned</Badge>
			{/if}
			{#if o.source}
				<Badge variant="outline">{o.source}</Badge>
			{/if}
		</div>
	</header>

	<section class="mb-8 rounded-lg border bg-card p-5">
		<h2 class="text-sm font-medium">Metadata</h2>
		<dl class="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
			<div>
				<dt class="text-xs text-muted-foreground">NAR hash</dt>
				<dd class="mt-0.5 font-mono text-xs break-all">{nar.narHash}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">NAR size</dt>
				<dd class="mt-0.5 font-mono text-xs">
					{formatBytes(nar.narSize)}
					<span class="text-muted-foreground">
						· {formatCount(nar.numChunks)} chunk{nar.numChunks === 1 ? '' : 's'}
					</span>
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Created</dt>
				<dd class="mt-0.5 font-mono text-xs">{formatIsoDateTime(o.createdAt)}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Last accessed</dt>
				<dd class="mt-0.5 font-mono text-xs">{formatIsoDateTime(o.lastAccessedAt)}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Deriver</dt>
				<dd class="mt-0.5 font-mono text-xs break-all">{o.deriver ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Content address</dt>
				<dd class="mt-0.5 font-mono text-xs break-all">{o.ca ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Pushed by</dt>
				<dd class="mt-0.5 font-mono text-xs">{o.createdBy ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Signatures</dt>
				<dd class="mt-0.5">
					{#if o.sigs.length === 0}
						<span class="font-mono text-xs text-muted-foreground">none</span>
					{:else}
						<ul class="space-y-1">
							{#each o.sigs as sig (sig)}
								<li class="font-mono text-xs break-all">{sig}</li>
							{/each}
						</ul>
					{/if}
				</dd>
			</div>
		</dl>

		{#if isPinned}
			<div class="mt-4 border-t pt-4">
				<h3 class="text-xs text-muted-foreground">Pins</h3>
				<ul class="mt-1.5 space-y-1 text-sm">
					{#if data.pins.anonymous}
						<li class="flex flex-wrap items-center gap-2">
							<Pin class="size-3.5 text-primary" />
							<span>Pinned {formatIsoDateTime(data.pins.anonymous.createdAt)}</span>
							{#if data.pins.anonymous.note}
								<span class="text-muted-foreground">— {data.pins.anonymous.note}</span>
							{/if}
						</li>
					{/if}
					{#each data.pins.named as pin (pin.name)}
						<li class="flex flex-wrap items-center gap-2">
							<Pin class="size-3.5 text-primary" />
							<span class="font-mono text-xs">{pin.name}</span>
							<span class="text-muted-foreground"
								>revision of {formatIsoDateTime(pin.createdAt)}</span
							>
							{#if pin.note}
								<span class="text-muted-foreground">— {pin.note}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>

	<section class="mb-8">
		<h2 class="mb-1 text-sm font-medium">
			References
			<span class="font-normal text-muted-foreground">({formatCount(data.references.length)})</span>
		</h2>
		<p class="mb-3 text-xs text-muted-foreground">Paths this store path depends on.</p>
		{#if data.references.length === 0}
			<div class="rounded-lg border border-dashed py-10 text-center">
				<p class="text-sm text-muted-foreground">No references.</p>
			</div>
		{:else}
			<StorePathTable
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
								? `available from ${ref.elsewhere.host}`
								: undefined
					};
				})}
			/>
		{/if}
	</section>

	<section class="mb-8">
		<h2 class="mb-1 text-sm font-medium">
			Referrers
			<span class="font-normal text-muted-foreground">({formatCount(data.referrers.total)})</span>
		</h2>
		<p class="mb-3 text-xs text-muted-foreground">
			Paths in this cache that depend on this store path.
		</p>
		{#if data.referrers.rows.length === 0}
			<div class="rounded-lg border border-dashed py-10 text-center">
				<p class="text-sm text-muted-foreground">No referrers.</p>
			</div>
		{:else}
			<StorePathTable
				rows={data.referrers.rows.map((referrer) => ({
					href: `${cacheHref}/paths/${referrer.hash}`,
					storePath: referrer.storePath,
					hash: referrer.hash,
					createdAt: referrer.createdAt,
					narSize: referrer.narSize
				}))}
			/>
			{#if data.referrers.total > data.referrers.rows.length}
				<p class="mt-2 text-xs text-muted-foreground">
					and {formatCount(data.referrers.total - data.referrers.rows.length)} more…
				</p>
			{/if}
		{/if}
	</section>

	<section class="mb-8">
		<h2 class="mb-3 text-sm font-medium">
			Chunks
			<span class="font-normal text-muted-foreground">({formatCount(data.chunks.length)})</span>
		</h2>
		{#if data.chunks.length === 0}
			<div class="rounded-lg border border-dashed py-10 text-center">
				<p class="text-sm text-muted-foreground">No chunks recorded for this NAR.</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border">
				<table class="w-full text-sm">
					<thead class="border-b bg-muted text-left text-xs text-muted-foreground">
						<tr>
							<th class="w-14 px-4 py-2.5 font-medium">#</th>
							<th class="px-4 py-2.5 font-medium">Chunk hash</th>
							<th class="w-28 px-4 py-2.5 text-right font-medium">Size</th>
							<th class="w-28 px-4 py-2.5 text-right font-medium">Stored</th>
							<th class="w-24 px-4 py-2.5 font-medium">Codec</th>
							<th class="w-48 px-4 py-2.5 font-medium">Dedup</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each data.chunks as chunk (chunk.seq)}
							<tr class="transition-colors hover:bg-muted/30">
								<td class="px-4 py-2.5 font-mono text-xs text-muted-foreground">{chunk.seq}</td>
								<td class="px-4 py-2.5 font-mono text-xs break-all">
									{chunk.chunkHash}
								</td>
								<td class="px-4 py-2.5 text-right font-mono text-xs">
									{chunk.chunkSize != null ? formatBytes(chunk.chunkSize) : '—'}
								</td>
								<td class="px-4 py-2.5 text-right font-mono text-xs">
									{chunk.fileSize != null ? formatBytes(chunk.fileSize) : '—'}
								</td>
								<td class="px-4 py-2.5 font-mono text-xs">{chunk.compression}</td>
								<td class="px-4 py-2.5 text-xs text-muted-foreground">
									{#if chunk.sharedNars > 0}
										shared with {formatCount(chunk.sharedNars)} other NAR{chunk.sharedNars === 1
											? ''
											: 's'}
									{:else}
										unique to this NAR
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
