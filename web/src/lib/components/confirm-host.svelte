<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import { confirmState, settle } from '$lib/confirm.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { TriangleAlert } from '@lucide/svelte';

	const p = $derived(confirmState.pending);
	// Fresh text field for every request: a writable derived that the input
	// binds to, reset to '' whenever `p` changes.
	let typed = $derived.by(() => {
		void p;
		return '';
	});
	const unlocked = $derived(!p?.typeToConfirm || typed === p.typeToConfirm);
	const inputId = $props.id();
</script>

<AlertDialog.Root
	open={p !== null}
	onOpenChange={(open) => {
		if (!open) settle(false);
	}}
>
	<AlertDialog.Portal>
		<AlertDialog.Overlay
			class="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-foreground/20 backdrop-blur-[2px]"
		/>
		<AlertDialog.Content
			class="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-(--shadow-sheet)"
		>
			{#if p}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						if (unlocked) settle(true);
					}}
				>
					<div class="flex gap-4 p-5">
						{#if p.tone === 'danger'}
							<div
								class="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10"
							>
								<TriangleAlert class="size-4.5 text-destructive" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<AlertDialog.Title class="text-base font-semibold">{p.title}</AlertDialog.Title>
							{#if p.description}
								<AlertDialog.Description
									class="mt-1.5 text-sm leading-relaxed text-muted-foreground"
								>
									{p.description}
								</AlertDialog.Description>
							{/if}
							{#if p.typeToConfirm}
								<label for={inputId} class="mt-4 block text-sm">
									Type <code class="rounded bg-muted px-1 py-px font-mono text-[0.8125rem]"
										>{p.typeToConfirm}</code
									> to confirm
								</label>
								<Input
									id={inputId}
									bind:value={typed}
									autocomplete="off"
									spellcheck={false}
									class="mt-2 font-mono"
								/>
							{/if}
						</div>
					</div>
					<div class="flex justify-end gap-2 border-t bg-subtle px-5 py-3">
						<AlertDialog.Cancel>
							{#snippet child({ props })}
								<Button variant="ghost" {...props}>Cancel</Button>
							{/snippet}
						</AlertDialog.Cancel>
						<Button
							type="submit"
							disabled={!unlocked}
							class={p.tone === 'danger'
								? 'bg-destructive text-white shadow-none hover:bg-destructive/90'
								: ''}
						>
							{p.confirmLabel}
						</Button>
					</div>
				</form>
			{/if}
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
