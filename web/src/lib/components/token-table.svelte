<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastErrors } from '$lib/enhance';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatBits } from '$lib/permission-bits';
	import { formatDate } from '$lib/format';
	import { KeyRound, Trash2 } from '@lucide/svelte';

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
		}[];
		/** Form action revoking a token by hidden `id` field. */
		revokeAction?: string;
		emptyText?: string;
	} = $props();

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
	<div class="rounded-lg border border-dashed py-12 text-center">
		<KeyRound class="mx-auto mb-3 size-6 text-muted-foreground" />
		<p class="text-sm text-muted-foreground">{emptyText}</p>
	</div>
{:else}
	<div class="overflow-x-auto rounded-lg border">
		<table class="w-full text-sm">
			<thead class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
				<tr>
					<th class="px-4 py-2.5 font-medium">Token</th>
					<th class="px-4 py-2.5 font-medium">Scope</th>
					<th class="px-4 py-2.5 font-medium">Permissions</th>
					<th class="px-4 py-2.5 font-medium">Created</th>
					<th class="px-4 py-2.5 font-medium">Expires</th>
					<th class="px-4 py-2.5 font-medium">Status</th>
					<th class="w-24 px-4 py-2.5"></th>
				</tr>
			</thead>
			<tbody class="divide-y">
				{#each tokens as t (t.id)}
					{@const entries = scopeEntries(t.scope)}
					<tr class="transition-colors hover:bg-muted/30">
						<td class="px-4 py-2.5 font-medium">{t.name}</td>
						<td class="px-4 py-2.5">
							{#each entries as entry, i (entry.cache)}
								{#if i > 0},{/if}
								{#if entry.cache === '*'}
									<span class="text-muted-foreground">all caches</span>
								{:else}
									<code class="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.cache}</code>
								{/if}
							{/each}
						</td>
						<td class="px-4 py-2.5 text-muted-foreground">
							{[...new Set(entries.map((e) => e.perms))].join('; ')}
						</td>
						<td class="px-4 py-2.5 text-muted-foreground">{formatDate(t.createdAt)}</td>
						<td class="px-4 py-2.5 text-muted-foreground">
							{t.expiresAt ? formatDate(t.expiresAt) : 'never'}
						</td>
						<td class="px-4 py-2.5">
							{#if t.status === 'revoked'}
								<span class="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
									revoked
								</span>
							{:else if t.status === 'expired'}
								<span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
									expired
								</span>
							{:else if t.status === 'suspended'}
								<span
									class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400"
									title="Inert while the account is deactivated; works again on reactivation"
								>
									suspended
								</span>
							{:else}
								<span
									class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
								>
									active
								</span>
							{/if}
						</td>
						<td class="px-4 py-1.5 text-right">
							{#if t.status === 'active' || t.status === 'suspended'}
								<form method="POST" action={revokeAction} use:enhance={toastErrors()}>
									<input type="hidden" name="id" value={t.id} />
									<Button
										type="submit"
										variant="ghost"
										size="sm"
										class="text-muted-foreground hover:text-destructive"
									>
										<Trash2 class="size-4" /> Revoke
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
