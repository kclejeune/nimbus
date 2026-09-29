// App-wide confirmation dialog. `ask()` opens the single <ConfirmHost> mounted
// in the root layout and resolves true/false, replacing window.confirm() so
// destructive actions explain their consequences in the app's own UI.

export interface ConfirmOptions {
	title: string;
	/** What happens, in plain terms: what is lost, what is kept. */
	description?: string;
	/** Names the action ("Delete cache"), never "OK". */
	confirmLabel: string;
	tone?: 'danger' | 'default';
	/** Require typing this exact text to enable confirm, for irreversible,
	 *  wide-blast-radius actions (deleting a cache). */
	typeToConfirm?: string;
}

interface Pending extends ConfirmOptions {
	resolve: (ok: boolean) => void;
}

export const confirmState = $state<{ pending: Pending | null }>({ pending: null });

export function ask(options: ConfirmOptions): Promise<boolean> {
	// A second request while one is open declines the first (it can't be
	// answered any more once its dialog is replaced).
	confirmState.pending?.resolve(false);
	return new Promise((resolve) => {
		confirmState.pending = { ...options, resolve };
	});
}

export function settle(ok: boolean): void {
	const pending = confirmState.pending;
	confirmState.pending = null;
	pending?.resolve(ok);
}
