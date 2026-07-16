<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { formatBytes, formatCount, gibInputValue } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import GrantBitsPicker from '$lib/components/grant-bits-picker.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { ArrowLeft, Check, Pin, Trash2, X } from '@lucide/svelte';

	let { data, form } = $props();
	const c = $derived(data.cache);
	// Destroy-only (cd) holders can view but not save configuration.
	const canConfigure = $derived(data.permissions.canConfigure);
	let submitting = $state(false);
	let renaming = $state(false);
	let deleting = $state(false);
	let addingRoot = $state(false);

	type Root = (typeof data.roots)[number];
	// Named pins group their revision rows (newest first, per the load order);
	// anonymous quick pins render flat below them.
	const namedPins = $derived.by(() => {
		const groups = new Map<
			string,
			{ name: string; keepRevisions: number | null; revisions: Root[] }
		>();
		for (const root of data.roots) {
			if (!root.pinName) continue;
			let group = groups.get(root.pinName);
			if (!group) {
				group = { name: root.pinName, keepRevisions: root.keepRevisions, revisions: [] };
				groups.set(root.pinName, group);
			}
			group.revisions.push(root);
		}
		return [...groups.values()];
	});
	const anonRoots = $derived(data.roots.filter((r) => !r.pinName));

	const maxGib = $derived(gibInputValue(c.retentionMaxBytes));
</script>

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
	<a
		href="/caches/{c.name}"
		class="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" />
		{c.name}
	</a>

	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Changing compression affects only newly pushed paths.
		</p>
	</header>

	<form
		method="POST"
		action="?/save"
		use:enhance={toastErrors(() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		})}
		class="space-y-6"
	>
		<div class="flex items-center gap-3">
			<input
				id="is_public"
				name="is_public"
				type="checkbox"
				checked={c.isPublic}
				disabled={!canConfigure || !data.isAdmin}
				class="size-4 rounded border-input text-primary focus:ring-ring"
			/>
			<Label for="is_public" class="font-normal">
				Public — anyone can pull without a token
				{#if !data.isAdmin}
					<span class="text-xs text-muted-foreground">(admins only)</span>
				{/if}
			</Label>
			{#if !data.isAdmin}
				<!-- Disabled checkboxes don't submit; preserve the current value. -->
				{#if c.isPublic}<input type="hidden" name="is_public" value="on" />{/if}
			{/if}
		</div>

		<div class="grid grid-cols-2 gap-4">
			<div class="space-y-2">
				<Label for="priority">Priority</Label>
				<Input
					id="priority"
					name="priority"
					type="number"
					value={c.priority}
					disabled={!canConfigure}
				/>
			</div>
			<div class="space-y-2">
				<Label for="compression">Compression</Label>
				<select
					id="compression"
					name="compression"
					value={c.compression}
					disabled={!canConfigure}
					class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				>
					<option value="zstd">zstd</option>
					<option value="gzip">gzip</option>
					<option value="none">none</option>
				</select>
			</div>
		</div>

		<div>
			<h2 class="text-sm font-medium">Retention</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Retention is closure-aware: a path survives while anything recently pulled (or pinned below)
				still depends on it. When over the size limit, least-recently-used closures are evicted
				first. Storage is reclaimed by the nightly garbage collection, or immediately after a push
				tips the cache over its limit.
			</p>
			<div class="mt-4 grid grid-cols-2 gap-4">
				<div class="space-y-2">
					<Label for="retention_period">Max age (days)</Label>
					<Input
						id="retention_period"
						name="retention_period"
						type="number"
						placeholder="No expiry"
						value={c.retentionDays ?? ''}
						disabled={!canConfigure}
					/>
				</div>
				<div class="space-y-2">
					<Label for="retention_max_gib">Size limit (GiB)</Label>
					<Input
						id="retention_max_gib"
						name="retention_max_gib"
						type="number"
						step="0.1"
						min="0"
						placeholder="No limit"
						value={maxGib}
						disabled={!canConfigure}
					/>
				</div>
			</div>
		</div>

		<div class="space-y-2">
			<Label>Upstream caches</Label>
			{#if c.upstreams.length > 0}
				<ul class="divide-y rounded-lg border">
					{#each c.upstreams as upstream (upstream.id)}
						<li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
							<div class="min-w-0 flex-1">
								<div class="truncate font-mono text-xs">{upstream.url}</div>
								<div class="mt-0.5 text-xs text-muted-foreground">
									{upstream.keyName ? `signed by ${upstream.keyName}` : 'no signature check'}
									· TTL {upstream.ttl}
									{#if upstream.enforced}
										· <span class="text-amber-600 dark:text-amber-400">enforced</span>
									{/if}
								</div>
							</div>
							<select
								name="upstream_mode_{upstream.id}"
								value={upstream.mode}
								disabled={!canConfigure}
								class="flex h-8 w-44 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
								aria-label="Mode for {upstream.url}"
							>
								<option value="inherit">Default ({upstream.defaultMode})</option>
								<option value="off" disabled={upstream.enforced}>Off</option>
								<option value="redirect">Redirect</option>
								<option value="persist" disabled={!data.isAdmin}>
									Persist into this cache{data.isAdmin ? '' : ' (admins only)'}
								</option>
							</select>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">No upstreams are registered on this server.</p>
			{/if}
			<p class="text-xs text-muted-foreground">
				Upstream trust (URL, public key, TTL) is server-wide{#if data.isAdmin}
					— manage it on the <a href="/upstreams" class="underline">Upstreams</a> page{/if}. Here
				you pick how this cache uses each one: paths already available from an enabled upstream are
				skipped at push time and served through this cache on pull. “Persist” copies each hit path
				into this cache in the background — re-signed, served locally, immune to upstream garbage
				collection. Enforced upstreams cannot be turned off.
			</p>
		</div>

		{#if form?.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}

		<div class="flex items-center gap-3">
			<Button type="submit" disabled={submitting}>
				{submitting ? 'Saving…' : 'Save changes'}
			</Button>
			{#if form?.saved}
				<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
					<Check class="size-4" /> Saved
				</span>
			{/if}
		</div>
	</form>

	<hr class="my-10 border-border" />

	<section class="space-y-4">
		<div>
			<h2 class="text-sm font-medium">Access</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Who can use this cache beyond {c.isPublic ? 'anonymous public pulls' : 'admins'}. Tokens are
				permission snapshots — changes here don't alter already-minted tokens (revoke instead).
			</p>
		</div>

		<div class="overflow-x-auto rounded-lg border">
			<table class="w-full text-sm">
				<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
					<tr>
						<th class="px-4 py-2.5 font-medium">Subject</th>
						<th class="px-4 py-2.5 font-medium">Permissions</th>
						<th class="px-4 py-2.5 font-medium">Source</th>
						<th class="w-14 px-4 py-2.5"></th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each data.access as grant (grant.id)}
						<tr class="transition-colors hover:bg-muted/30">
							<td class="px-4 py-2.5">
								<a
									href="/{grant.subjectType === 'group' ? 'groups' : 'users'}/{grant.subjectId}"
									class="font-medium hover:underline">{grant.subjectLabel}</a
								>
							</td>
							<td class="px-4 py-2.5 text-muted-foreground">{formatGrantActions(grant.actions)}</td>
							<td class="px-4 py-2.5">
								{#if grant.direct}
									<span class="text-muted-foreground">this cache</span>
								{:else}
									<code class="rounded bg-muted px-1.5 py-0.5 text-xs">{grant.pattern}</code>
									<span class="text-xs text-muted-foreground">
										pattern grant — edit on the subject's page</span
									>
								{/if}
							</td>
							<td class="px-4 py-1.5 text-right">
								{#if grant.direct && data.isAdmin}
									<form method="POST" action="?/accessRemove" use:enhance={toastErrors()}>
										<input type="hidden" name="id" value={grant.id} />
										<input type="hidden" name="subject_type" value={grant.subjectType} />
										<input type="hidden" name="subject_id" value={grant.subjectId} />
										<Button type="submit" variant="ghost" size="icon" aria-label="Remove access">
											<Trash2 class="size-4" />
										</Button>
									</form>
								{/if}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="4" class="px-4 py-3 text-sm text-muted-foreground">
								No grants apply to this cache.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.isAdmin}
			<form method="POST" action="?/accessAdd" use:enhance={toastErrors()} class="space-y-3">
				<div class="flex flex-wrap items-end gap-3">
					<div class="min-w-56 flex-1 space-y-2">
						<Label for="subject">Add access for</Label>
						<select
							id="subject"
							name="subject"
							class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
						>
							{#each data.subjects as subject (subject.value)}
								<option value={subject.value}>{subject.label}</option>
							{/each}
						</select>
					</div>
					<Button type="submit" variant="secondary">Add</Button>
				</div>
				<GrantBitsPicker />
				{#if form?.accessError}
					<p class="text-sm text-destructive">{form.accessError}</p>
				{/if}
			</form>
		{/if}
	</section>

	<hr class="my-10 border-border" />

	<section class="space-y-4">
		<div>
			<h2 class="inline-flex items-center gap-1.5 text-sm font-medium">
				<Pin class="size-3.5" /> Pinned paths
			</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Garbage collection never removes a pinned path or anything in its closure, regardless of age
				or size limits. Paths can also be pinned from the store path list.
			</p>
		</div>

		{#if namedPins.length > 0}
			<ul class="divide-y rounded-lg border">
				{#each namedPins as pin (pin.name)}
					<li class="px-4 py-2.5">
						<div class="flex items-center gap-3">
							<div class="min-w-0 flex-1">
								<span class="text-sm font-medium">{pin.name}</span>
								<span class="text-xs text-muted-foreground">
									· {pin.revisions.length}
									{pin.revisions.length === 1 ? 'revision' : 'revisions'}{pin.keepRevisions
										? ` (keeps last ${pin.keepRevisions})`
										: ''}
								</span>
							</div>
							<form method="POST" action="?/removeRoot" use:enhance={toastErrors()}>
								<input type="hidden" name="pin" value={pin.name} />
								<button
									type="submit"
									title="Remove pin and all revisions"
									class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								>
									<X class="size-4" />
								</button>
							</form>
						</div>
						<ul class="mt-1 space-y-0.5">
							{#each pin.revisions as root, i (root.hash)}
								<li class="text-xs">
									<span class="font-mono">{root.hash}</span>
									<span class="text-muted-foreground">
										{#if i === 0}· current{/if}
										{#if root.inCache}
											· {formatCount(root.closureObjects)} paths ({formatBytes(root.closureBytes)})
										{:else}
											· not in this cache
										{/if}
										{root.note ? `· ${root.note}` : ''}
									</span>
								</li>
							{/each}
						</ul>
					</li>
				{/each}
			</ul>
		{/if}

		{#if anonRoots.length > 0}
			<ul class="divide-y rounded-lg border">
				{#each anonRoots as root (root.hash)}
					<li class="flex items-center gap-3 px-4 py-2.5">
						<div class="min-w-0 flex-1">
							<div class="truncate font-mono text-xs">{root.hash}</div>
							<div class="mt-0.5 text-xs text-muted-foreground">
								{#if root.inCache}
									protects {formatCount(root.closureObjects)} paths ({formatBytes(
										root.closureBytes
									)}){root.note ? ` — ${root.note}` : ''}
								{:else}
									not in this cache{root.note ? ` — ${root.note}` : ''}
								{/if}
							</div>
						</div>
						<form method="POST" action="?/removeRoot" use:enhance={toastErrors()}>
							<input type="hidden" name="hash" value={root.hash} />
							<button
								type="submit"
								title="Unpin"
								class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<X class="size-4" />
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.roots.length === 0}
			<p class="text-sm text-muted-foreground">Nothing pinned.</p>
		{/if}

		<form
			method="POST"
			action="?/addRoot"
			use:enhance={toastErrors(() => {
				addingRoot = true;
				return async ({ update }) => {
					await update();
					addingRoot = false;
				};
			})}
			class="flex flex-wrap items-end gap-3"
		>
			<div class="min-w-56 flex-1 space-y-2">
				<Label for="root_path">Store path or hash</Label>
				<Input
					id="root_path"
					name="path"
					placeholder="/nix/store/xxxx… or 32-char hash"
					autocomplete="off"
				/>
			</div>
			<div class="w-36 space-y-2">
				<Label for="pin_name">Name</Label>
				<Input
					id="pin_name"
					name="pin_name"
					placeholder="e.g. v1.7 (optional)"
					autocomplete="off"
				/>
			</div>
			<div class="w-28 space-y-2">
				<Label for="keep_revisions">Keep last</Label>
				<Input
					id="keep_revisions"
					name="keep_revisions"
					type="number"
					min="1"
					placeholder="all"
					autocomplete="off"
				/>
			</div>
			<div class="w-40 space-y-2">
				<Label for="root_note">Note</Label>
				<Input id="root_note" name="note" placeholder="optional" autocomplete="off" />
			</div>
			<Button type="submit" variant="outline" disabled={addingRoot}>
				<Pin class="size-4" />
				{addingRoot ? 'Pinning…' : 'Pin'}
			</Button>
		</form>
		<p class="text-xs text-muted-foreground">
			Naming a pin gives it a revision history: re-pinning the same name keeps the old revisions
			protected too (bounded by “keep last”). Unnamed pins protect a single path's closure.
		</p>
		{#if form?.rootError}
			<p class="text-sm text-destructive">{form.rootError}</p>
		{/if}
	</section>

	<hr class="my-10 border-border" />

	{#if canConfigure}
		<section class="space-y-4">
			<div>
				<h2 class="text-sm font-medium">Rename cache</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					The signing key is preserved, so already-pushed paths stay trusted. The pull URL changes
					to the new name.
				</p>
			</div>
			<form
				method="POST"
				action="?/rename"
				use:enhance={toastErrors(() => {
					renaming = true;
					return async ({ update }) => {
						await update({ reset: false });
						renaming = false;
					};
				})}
				class="flex flex-wrap items-end gap-3"
			>
				<div class="min-w-56 flex-1 space-y-2">
					<Label for="new_name">New name</Label>
					<Input id="new_name" name="new_name" value={c.name} autocomplete="off" />
				</div>
				<Button type="submit" variant="outline" disabled={renaming}>
					{renaming ? 'Renaming…' : 'Rename'}
				</Button>
			</form>
			{#if form?.renameError}
				<p class="text-sm text-destructive">{form.renameError}</p>
			{/if}
		</section>
	{/if}

	{#if data.permissions.canDestroy}
		<div class="mt-10 rounded-lg border border-destructive/40 p-5">
			<h2 class="text-sm font-medium text-destructive">Danger zone</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Deleting removes the cache and hides its paths. Stored data is retained but the cache is no
				longer reachable.
			</p>
			<form
				method="POST"
				action="?/delete"
				class="mt-4"
				use:enhance={toastErrors(
					confirmFirst(`Delete cache "${c.name}"? Clients can no longer pull from it.`, () => {
						deleting = true;
						return async ({ update }) => {
							await update();
							deleting = false;
						};
					})
				)}
			>
				<Button type="submit" variant="destructive" disabled={deleting}>
					<Trash2 class="size-4" />
					{deleting ? 'Deleting…' : 'Delete cache'}
				</Button>
			</form>
			{#if form?.deleteError}
				<p class="mt-3 text-sm text-destructive">{form.deleteError}</p>
			{/if}
		</div>
	{/if}
</div>
