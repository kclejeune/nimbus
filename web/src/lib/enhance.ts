import { toast } from 'svelte-sonner';
import type { SubmitFunction } from '@sveltejs/kit';

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
/**
 * `use:enhance` submit wrapper for destructive forms: asks for confirmation
 * and cancels the submit on decline. Composes with toastErrors —
 * `use:enhance={toastErrors(confirmFirst(() => 'Delete X?'))}`.
 */
export function confirmFirst(
	message: string | (() => string),
	inner?: SubmitFunction
): SubmitFunction {
	return (input) => {
		if (!confirm(typeof message === 'function' ? message() : message)) {
			input.cancel();
			return;
		}
		return inner?.(input);
	};
}

export function toastErrors(inner?: SubmitFunction): SubmitFunction {
	return (input) => {
		const innerReturn = inner?.(input);
		return async (opts) => {
			const innerCallback = await innerReturn;
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
