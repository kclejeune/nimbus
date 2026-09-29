import { toast } from 'svelte-sonner';
import type { SubmitFunction } from '@sveltejs/kit';
import { ask, type ConfirmOptions } from '$lib/confirm.svelte';

/**
 * `use:enhance` submit wrapper for destructive forms: asks in the app's
 * confirmation dialog and cancels the submit on decline. Composes with
 * toastErrors — `use:enhance={toastErrors(confirmFirst({ … }))}`.
 */
export function confirmFirst(
	options: ConfirmOptions | (() => ConfirmOptions),
	inner?: SubmitFunction
): SubmitFunction {
	return async (input) => {
		const ok = await ask(typeof options === 'function' ? options() : options);
		if (!ok) {
			input.cancel();
			return;
		}
		return inner?.(input);
	};
}

/**
 * `use:enhance` wrapper: a thrown action error (403 from a permission guard,
 * etc.) surfaces as an error toast instead of navigating to the error page —
 * the page state stays intact. Validation failures (`fail()`) still flow to
 * the `form` prop for inline rendering.
 *
 * Wraps an optional inner submit function (pending-state toggles, confirm
 * dialogs); on error the inner callback still runs so it can reset its
 * pending state, but with a no-op `update` so the error result is never
 * applied.
 */
export function toastErrors(inner?: SubmitFunction): SubmitFunction {
	// Async so an async inner (confirmFirst) settles — and can cancel() —
	// before SvelteKit decides whether to submit; it awaits this function.
	return async (input) => {
		const innerCallback = await inner?.(input);
		return async (opts) => {
			if (opts.result.type === 'error') {
				toast.error(opts.result.error?.message ?? 'Request failed');
				if (innerCallback) {
					await innerCallback({ ...opts, update: async () => {} });
				}
				return;
			}
			if (innerCallback) await innerCallback(opts);
			else await opts.update();
		};
	};
}
