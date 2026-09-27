import { sleep } from './platform';
import { TtlMemo } from './ttl-memo';

/** Share values, never request-owned I/O promises. Abandoned leaders expire. */
export class AsyncMemo<V> {
	private readonly values: TtlMemo<V>;
	// A lease per key being loaded. `settled` carries a result the leader
	// declined to memoize (ttl <= 0) to the waiters polling that lease, which
	// would otherwise each take the lease and reload in turn.
	private readonly loads = new Map<string, { deadline: number; settled?: { value: V } }>();
	constructor(
		ttl: number,
		private readonly capacity: number,
		private readonly leaseMs = 2_000
	) {
		this.values = new TtlMemo(ttl, capacity);
	}
	clear(key?: string): void {
		if (key === undefined) {
			this.values.clear();
			this.loads.clear();
		} else {
			this.values.delete(key);
			this.loads.delete(key);
		}
	}
	async get(key: string, load: () => Promise<V>, ttl?: (value: V) => number): Promise<V> {
		let interval = 5;
		let waitedOn: { deadline: number; settled?: { value: V } } | undefined;
		for (;;) {
			const value = this.values.get(key);
			if (value !== undefined) return value;
			const active = this.loads.get(key);
			// Only a waiter shares an unmemoized result: a later caller reloads.
			if (active?.settled && active === waitedOn) return active.settled.value;
			if (active && !active.settled && active.deadline > Date.now()) {
				waitedOn = active;
				await sleep(interval + Math.random() * interval);
				interval = Math.min(20, interval * 2);
				continue;
			}
			const marker: { deadline: number; settled?: { value: V } } = {
				deadline: Date.now() + this.leaseMs
			};
			if (this.loads.size >= this.capacity) {
				for (const [k, m] of this.loads) if (m.deadline <= Date.now()) this.loads.delete(k);
				if (this.loads.size >= this.capacity) this.loads.delete(this.loads.keys().next().value!);
			}
			this.loads.set(key, marker);
			try {
				const result = await load();
				if (this.loads.get(key) === marker) {
					const ms = ttl?.(result);
					if (ms === undefined || ms > 0) this.values.set(key, result, ms);
					// Kept until the next leader replaces it or the capacity sweep
					// finds it past its deadline.
					else marker.settled = { value: result };
				}
				return result;
			} finally {
				if (this.loads.get(key) === marker && !marker.settled) this.loads.delete(key);
			}
		}
	}
}
