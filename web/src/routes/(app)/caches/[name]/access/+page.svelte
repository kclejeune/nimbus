<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import GrantBitsPicker from '$lib/components/grant-bits-picker.svelte';
	import { formatGrantActions } from '$lib/permission-bits';
	import { Trash2 } from '@lucide/svelte';
	import Panel from '$lib/components/layout/panel.svelte';

	let { data, form } = $props();
	const c = $derived({ isPublic: data.isPublic });
</script>

<Panel title="Access" flush>
	{#snippet description()}
		Who can use this cache beyond {c.isPublic ? 'anonymous public pulls' : 'admins'}. Tokens are
		permission snapshots: changes here don't alter tokens already issued, so revoke those instead.
	{/snippet}
	<div class="relative overflow-x-auto">
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
