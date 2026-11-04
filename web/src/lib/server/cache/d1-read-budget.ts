import { AsyncLocalStorage } from 'node:async_hooks';

const READ_RETRIES = 2;
const READ_RETRY_WINDOW_MS = 5_000;

/** Shared by the replica and primary of one logical SELECT-only read.
 * Initial statements still run: a multi-query config load is not truncated.
 * Only additional attempts consume this budget. No I/O promises are shared. */
class ReadRetryBudget {
	private left = READ_RETRIES;
	private closed = false;
	private readonly until = Date.now() + READ_RETRY_WINDOW_MS;
	get remainingMs(): number {
		return this.closed ? 0 : Math.max(0, this.until - Date.now());
	}
	get used(): number {
		return READ_RETRIES - this.left;
	}
	reserve(delayMs: number): boolean {
		if (this.left <= 0 || delayMs >= this.remainingMs) return false;
		this.left--;
		return true;
	}
	close(): void {
		this.closed = true;
	}
}

const current = new AsyncLocalStorage<ReadRetryBudget>();
export const d1ReadBudget = () => current.getStore();

export async function withD1ReadBudget<T>(work: () => Promise<T>): Promise<T> {
	if (current.getStore()) return work();
	const budget = new ReadRetryBudget();
	return current.run(budget, async () => {
		try {
			return await work();
		} finally {
			// A losing read may finish after the response. It must not retry.
			budget.close();
		}
	});
}
