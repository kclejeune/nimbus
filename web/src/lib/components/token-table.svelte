<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatBits } from '$lib/permission-bits';
	import { formatDate } from '$lib/format';
	import { KeyRound } from '@lucide/svelte';
	import EmptyState from '$lib/components/layout/empty-state.svelte';
	import StatusBadge from '$lib/components/layout/status-badge.svelte';

	let {
		tokens,
		revokeAction = '?/revoke',
		emptyText = 'No tokens yet.'
	}: {
		tokens: {
			id: string;
			name: string;
			scope: string;
			createdAt: number;
			expiresAt: number | null;
			/** 'suspended': valid but inert while the owner is deactivated. */
			status: 'active' | 'expired' | 'revoked' | 'suspended';
			/** Present in the admin everyone view: renders the Owner column and
			 *  posts the owner with a revoke. */
			owner?: { id: string; name: string; email: string };
		}[];
		/** Form action revoking a token by hidden `id` field. */
		revokeAction?: string;
		emptyText?: string;
	} = $props();

	const showOwner = $derived(tokens.some((t) => t.owner));

	/** A token's scope JSON ({pattern: bits}) as {cache, perms} rows. */
	function scopeEntries(scopeJson: string): { cache: string; perms: string }[] {
		try {
			const s = JSON.parse(scopeJson) as Record<string, Record<string, unknown>>;
			return Object.entries(s).map(([cache, p]) => ({ cache, perms: formatBits(p) }));
		} catch {
			return [{ cache: scopeJson, perms: '—' }];
		}
	}
</script>

{#if tokens.length === 0}
	<EmptyState icon={KeyRound} title="No tokens yet" description={emptyText} />
{:else}
	<div class="table-frame">
		<table class="data-table">
			<thead>
				<tr>
					<th>Token</th>
					{#if showOwner}<th>Owner</th>{/if}
					<th>Scope</th>
					<th>Permissions</th>
					<th>Created</th>
					<th>Expires</th>
					<th>Status</th>
					<th class="w-24"><span class="sr-only">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each tokens as t (t.id)}
					{@const entries = scopeEntries(t.scope)}
					{@const inert = t.status === 'revoked' || t.status === 'expired'}
					<tr class={inert ? 'text-muted-foreground' : ''}>
						<td class="font-medium whitespace-nowrap">{t.name}</td>
						{#if showOwner}
							<td class="whitespace-nowrap">
								{#if t.owner}
									<a href="/users/{t.owner.id}" class="row-link font-normal" title={t.owner.email}
										>{t.owner.name || t.owner.email}</a
									>
								{/if}
							</td>
						{/if}
						<td>
							<div class="flex flex-wrap gap-1">
								{#each entries as entry (entry.cache)}
									{#if entry.cache === '*'}
										<span class="text-muted-foreground">All caches</span>
									{:else}
										<code
											class="rounded-[5px] border bg-subtle px-1.5 py-px font-mono text-xs whitespace-nowrap"
											>{entry.cache}</code
										>
									{/if}
								{/each}
							</div>
						</td>
						<td class="text-muted-foreground">
							{[...new Set(entries.map((e) => e.perms))].join('; ')}
						</td>
						<td class="whitespace-nowrap text-muted-foreground">{formatDate(t.createdAt)}</td>
						<td class="whitespace-nowrap text-muted-foreground">
							{t.expiresAt ? formatDate(t.expiresAt) : 'Never'}
						</td>
						<td>
							{#if t.status === 'revoked'}
								<StatusBadge tone="danger">Revoked</StatusBadge>
							{:else if t.status === 'expired'}
								<StatusBadge>Expired</StatusBadge>
							{:else if t.status === 'suspended'}
								<StatusBadge tone="warning" dot title="Works again when the account is reactivated">
									Suspended
								</StatusBadge>
							{:else}
								<StatusBadge tone="success" dot>Active</StatusBadge>
							{/if}
						</td>
						<td class="!py-1 text-right">
							{#if t.status === 'active' || t.status === 'suspended'}
								<form method="POST" action={revokeAction} use:enhance={toastErrors()}>
									<input type="hidden" name="id" value={t.id} />
									{#if t.owner}<input type="hidden" name="owner" value={t.owner.id} />{/if}
									<Button
										type="submit"
										variant="ghost"
										size="sm"
										class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
									>
										Revoke
									</Button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
