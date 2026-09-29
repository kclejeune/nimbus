<script lang="ts">
	import { enhance } from '$app/forms';
	import { confirmFirst, toastErrors } from '$lib/enhance';
	import { formatBytes, formatCount, gibInputValue } from '$lib/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import GrantBitsPicker from '$lib/components/grant-bits-picker.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { Check, Globe, Lock, Pin, Trash2, X } from '@lucide/svelte';
	import Page from '$lib/components/layout/page.svelte';
	import PageHeader from '$lib/components/layout/page-header.svelte';
	import Panel from '$lib/components/layout/panel.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

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

<Page width="narrow">
	<PageHeader
		title="Cache settings"
		description="Configuration, access, pins and lifecycle for this cache. Changing compression only affects paths pushed afterwards."
	/>

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
		<Panel title="General">
			<div class="space-y-5">
				<fieldset>
					<legend class="mb-2 text-sm font-medium">
						Visibility
						{#if !data.isAdmin}
							<span class="font-normal text-muted-foreground">(admins only)</span>
						{/if}
					</legend>
					<label
						class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-checked:border-primary/50 has-checked:bg-accent/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-60"
					>
						<input
							id="is_public"
							name="is_public"
							type="checkbox"
							checked={c.isPublic}
							disabled={!canConfigure || !data.isAdmin}
							class="mt-0.5 size-4 rounded border-input text-primary focus:ring-0 focus:ring-offset-0"
						/>
						<span>
							<span class="flex items-center gap-1.5 text-sm font-medium">
								{#if c.isPublic}<Globe class="size-3.5" />{:else}<Lock class="size-3.5" />{/if}
								Public
							</span>
							<span class="mt-0.5 block text-xs text-muted-foreground">
								Anyone can pull without a token. Pushing still needs one.
							</span>
						</span>
					</label>
					{#if !data.isAdmin}
						<!-- Disabled checkboxes don't submit; preserve the current value. -->
						{#if c.isPublic}<input type="hidden" name="is_public" value="on" />{/if}
					{/if}
				</fieldset>

				<div class="grid gap-4 sm:grid-cols-2">
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
							class="native-select"
						>
							<option value="zstd">zstd</option>
							<option value="gzip">gzip</option>
							<option value="none">none</option>
						</select>
					</div>
				</div>
			</div>
		</Panel>

		<Panel
			title="Retention"
			description="Closure-aware: a path survives while anything recently pulled, or pinned, still depends on it. Over the size limit, the least recently used closures go first. Space is reclaimed by the nightly garbage collection, or right after a push tips the cache over its limit."
		>
			<div class="grid gap-4 sm:grid-cols-2">
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
		</Panel>

		<Panel title="Upstream caches" flush>
			{#snippet description()}
				Paths already available from an enabled upstream are skipped at push time and served through
				this cache on pull. Persist copies each hit into this cache in the background, re-signed and
				safe from upstream garbage collection. Upstream trust is server-wide{#if data.isAdmin};
					manage it in <a
						href="/upstreams"
						class="font-medium text-foreground underline-offset-4 hover:underline">Upstreams</a
					>{/if}.
			{/snippet}
			{#if c.upstreams.length > 0}
				<ul class="divide-y">
					{#each c.upstreams as upstream (upstream.id)}
						<li class="flex flex-wrap items-center gap-3 px-5 py-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate font-mono text-[0.8125rem]">{upstream.url}</span>
									{#if upstream.enforced}
										<StatusBadge tone="warning" title="Enforced upstreams can't be turned off">
											Enforced
										</StatusBadge>
									{/if}
								</div>
								<div class="mt-0.5 text-xs text-muted-foreground">
									{upstream.keyName ? `Signed by ${upstream.keyName}` : 'No signature check'}, TTL
									<span class="font-mono">{upstream.ttl}</span>
								</div>
							</div>
							<select
								name="upstream_mode_{upstream.id}"
								value={upstream.mode}
								disabled={!canConfigure}
								class="native-select w-48"
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
				<p class="px-5 py-6 text-sm text-muted-foreground">
					No upstreams are registered on this server.
				</p>
			{/if}
		</Panel>

		{#if form?.error}
			<p role="alert" class="text-sm text-destructive">{form.error}</p>
		{/if}

		<div
			class="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border bg-card/95 px-4 py-3 shadow-(--shadow-sheet) backdrop-blur"
		>
			<span class="text-sm text-muted-foreground">
				{#if form?.saved}
					<span class="inline-flex items-center gap-1.5 text-success">
						<Check class="size-4" /> Saved
					</span>
				{:else}
					General, retention and upstream settings save together.
				{/if}
			</span>
			<Button type="submit" class="ms-auto" disabled={submitting || !canConfigure}>
				{submitting ? 'Saving…' : 'Save changes'}
			</Button>
		</div>
	</form>

	<div class="mt-10 space-y-6">
		<Panel title="Access" flush>
			{#snippet description()}
				Who can use this cache beyond {c.isPublic ? 'anonymous public pulls' : 'admins'}. Tokens are
				permission snapshots: changes here don't alter tokens already issued, so revoke those
				instead.
			{/snippet}
			<div class="overflow-x-auto">
				<table class="data-table">
					<thead>
						<tr>
							<th>Subject</th>
							<th>Permissions</th>
							<th>Source</th>
							<th class="w-14"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each data.access as grant (grant.id)}
							<tr>
								<td>
									<a
										href="/{grant.subjectType === 'group' ? 'groups' : 'users'}/{grant.subjectId}"
										class="row-link">{grant.subjectLabel}</a
									>
								</td>
								<td class="text-muted-foreground">{formatGrantActions(grant.actions)}</td>
								<td>
									{#if grant.direct}
										<span class="text-muted-foreground">This cache</span>
									{:else}
										<code class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs"
											>{grant.pattern}</code
										>
										<span class="ml-1 text-xs text-muted-foreground"
											>Pattern grant, edit it on the subject's page</span
										>
									{/if}
								</td>
								<td class="!py-1 text-right">
									{#if grant.direct && data.isAdmin}
										<form method="POST" action="?/accessRemove" use:enhance={toastErrors()}>
											<input type="hidden" name="id" value={grant.id} />
											<input type="hidden" name="subject_type" value={grant.subjectType} />
											<input type="hidden" name="subject_id" value={grant.subjectId} />
											<Button
												type="submit"
												variant="ghost"
												size="icon-sm"
												class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
												aria-label="Remove access for {grant.subjectLabel}"
											>
												<Trash2 />
											</Button>
										</form>
									{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="4" class="text-muted-foreground">No grants apply to this cache.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#snippet footer()}
				{#if data.isAdmin}
					<form
						method="POST"
						action="?/accessAdd"
						use:enhance={toastErrors()}
						class="w-full space-y-3 text-foreground"
					>
						<div class="flex flex-wrap items-end gap-3">
							<div class="min-w-56 flex-1 space-y-2">
								<Label for="subject">Grant access to</Label>
								<select id="subject" name="subject" class="native-select">
									{#each data.subjects as subject (subject.value)}
										<option value={subject.value}>{subject.label}</option>
									{/each}
								</select>
							</div>
							<Button type="submit" variant="outline">Grant access</Button>
						</div>
						<GrantBitsPicker />
						{#if form?.accessError}
							<p role="alert" class="text-sm text-destructive">{form.accessError}</p>
						{/if}
					</form>
				{:else}
					<span>Only admins can change who has access.</span>
				{/if}
			{/snippet}
		</Panel>

		<Panel
			title="Pinned paths"
			description="Garbage collection never removes a pinned path or anything in its closure, regardless of age or size limits. You can also pin paths from the store path list."
			flush
		>
			{#if data.roots.length === 0}
				<p class="px-5 py-6 text-sm text-muted-foreground">Nothing is pinned.</p>
			{:else}
				<ul class="divide-y">
					{#each namedPins as pin (pin.name)}
						<li class="px-5 py-3">
							<div class="flex items-center gap-3">
								<Pin class="size-3.5 text-primary" />
								<div class="min-w-0 flex-1">
									<span class="text-sm font-medium">{pin.name}</span>
									<span class="ml-1 text-xs text-muted-foreground">
										{pin.revisions.length}
										{pin.revisions.length === 1 ? 'revision' : 'revisions'}{pin.keepRevisions
											? `, keeps the last ${pin.keepRevisions}`
											: ''}
									</span>
								</div>
								<form method="POST" action="?/removeRoot" use:enhance={toastErrors()}>
									<input type="hidden" name="pin" value={pin.name} />
									<button
										type="submit"
										title="Remove pin and all revisions"
										aria-label="Remove pin {pin.name}"
										class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
									>
										<X class="size-4" />
									</button>
								</form>
							</div>
							<ul class="mt-2 ml-6 space-y-1 border-l pl-3">
								{#each pin.revisions as root, i (root.hash)}
									<li class="flex flex-wrap items-center gap-x-2 text-xs">
										<span class="font-mono">{root.hash}</span>
										{#if i === 0}<StatusBadge tone="primary">Current</StatusBadge>{/if}
										<span class="text-muted-foreground">
											{#if root.inCache}
												{formatCount(root.closureObjects)} paths, {formatBytes(root.closureBytes)}
											{:else}
												Not in this cache
											{/if}
											{root.note ? `(${root.note})` : ''}
										</span>
									</li>
								{/each}
							</ul>
						</li>
					{/each}
					{#each anonRoots as root (root.hash)}
						<li class="flex items-center gap-3 px-5 py-3">
							<Pin class="size-3.5 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<div class="truncate font-mono text-xs">{root.hash}</div>
								<div class="mt-0.5 text-xs text-muted-foreground">
									{#if root.inCache}
										Protects {formatCount(root.closureObjects)} paths ({formatBytes(
											root.closureBytes
										)}){root.note ? `: ${root.note}` : ''}
									{:else}
										Not in this cache{root.note ? `: ${root.note}` : ''}
									{/if}
								</div>
							</div>
							<form method="POST" action="?/removeRoot" use:enhance={toastErrors()}>
								<input type="hidden" name="hash" value={root.hash} />
								<button
									type="submit"
									title="Unpin"
									aria-label="Unpin"
									class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								>
									<X class="size-4" />
								</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			{#snippet footer()}
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
					class="w-full space-y-3 text-foreground"
				>
					<div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
						<div class="space-y-2">
							<Label for="root_path">Store path or hash</Label>
							<Input
								id="root_path"
								name="path"
								placeholder="/nix/store/… or 32-character hash"
								autocomplete="off"
								class="font-mono text-[0.8125rem] md:text-[0.8125rem]"
							/>
						</div>
						<div class="space-y-2">
							<Label for="pin_name">Name</Label>
							<Input id="pin_name" name="pin_name" placeholder="v1.7" autocomplete="off" />
						</div>
					</div>
					<div class="flex flex-wrap items-end gap-3">
						<div class="w-28 space-y-2">
							<Label for="keep_revisions">Keep last</Label>
							<Input
								id="keep_revisions"
								name="keep_revisions"
								type="number"
								min="1"
								placeholder="All"
								autocomplete="off"
							/>
						</div>
						<div class="min-w-40 flex-1 space-y-2">
							<Label for="root_note">Note</Label>
							<Input id="root_note" name="note" placeholder="Optional" autocomplete="off" />
						</div>
						<Button type="submit" variant="outline" disabled={addingRoot}>
							<Pin />
							{addingRoot ? 'Pinning…' : 'Pin path'}
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">
						Naming a pin gives it a revision history: pinning the same name again keeps the older
						revisions protected too, up to “Keep last”. Name and note are optional.
					</p>
					{#if form?.rootError}
						<p role="alert" class="text-sm text-destructive">{form.rootError}</p>
					{/if}
				</form>
			{/snippet}
		</Panel>

		{#if canConfigure}
			<Panel
				title="Rename cache"
				description="The signing key is kept, so paths already pushed stay trusted. The substituter URL changes to the new name."
			>
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
						<Input
							id="new_name"
							name="new_name"
							value={c.name}
							autocomplete="off"
							class="font-mono"
						/>
					</div>
					<Button type="submit" variant="outline" disabled={renaming}>
						{renaming ? 'Renaming…' : 'Rename cache'}
					</Button>
				</form>
				{#if form?.renameError}
					<p role="alert" class="mt-3 text-sm text-destructive">{form.renameError}</p>
				{/if}
			</Panel>
		{/if}

		{#if data.permissions.canDestroy}
			<Panel
				title="Delete cache"
				tone="danger"
				description="Removes the cache and hides its paths. Stored data is kept, but clients can no longer pull from it."
			>
				<form
					method="POST"
					action="?/delete"
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
						<Trash2 />
						{deleting ? 'Deleting…' : 'Delete cache'}
					</Button>
				</form>
				{#if form?.deleteError}
					<p role="alert" class="mt-3 text-sm text-destructive">{form.deleteError}</p>
				{/if}
			</Panel>
		{/if}
	</div>
</Page>
