import { sleep } from './platform';
import { TtlMemo } from './ttl-memo';

type Lease<V> = { deadline: number; settled?: { value: V } };
// Generations of a key share an invalidation flag, even after a new fill
// replaces the lease captured by an older waiter.
type Slot<V> = { cleared: boolean; lease?: Lease<V> };

/** Share values, never request-owned I/O promises. Abandoned leaders expire. */
export class AsyncMemo<V> {
	private readonly values: TtlMemo<V>;
	// A lease per key being loaded. `settled` carries a result the leader
	// declined to memoize (ttl <= 0) to the waiters polling that lease, which
	// would otherwise each take the lease and reload in turn.
	private readonly loads = new Map<string, Slot<V>>();
	constructor(
		ttl: number,
		private readonly capacity: number,
		private readonly leaseMs = 2_000
	) {
		this.values = new TtlMemo(ttl, capacity);
	}
	clear(key?: string): void {
		if (key === undefined) {
			for (const slot of this.loads.values()) slot.cleared = true;
			this.values.clear();
			this.loads.clear();
		} else {
			const slot = this.loads.get(key);
			if (slot) slot.cleared = true;
			this.values.delete(key);
			this.loads.delete(key);
		}
	}
	async get(key: string, load: () => Promise<V>, ttl?: (value: V) => number): Promise<V> {
		let interval = 5;
		let waitedOn: { slot: Slot<V>; lease: Lease<V> } | undefined;
		for (;;) {
			// A later caller can replace this key's settled lease before we
			// poll. Existing waiters still own that completed result; consulting
			// the map instead would join the newer fill or issue another read.
			if (waitedOn && !waitedOn.slot.cleared && waitedOn.lease.settled)
				return waitedOn.lease.settled.value;
			const value = this.values.get(key);
			if (value !== undefined) return value;
			let slot = this.loads.get(key);
			const active = slot?.lease;
			if (active && !active.settled && active.deadline > Date.now()) {
				waitedOn = { slot: slot!, lease: active };
				await sleep(interval + Math.random() * interval);
				interval = Math.min(20, interval * 2);
				continue;
			}
			const marker: Lease<V> = {
				deadline: Date.now() + this.leaseMs
			};
			if (!slot) {
				const evict = (key: string) => {
					this.loads.get(key)!.cleared = true;
					this.loads.delete(key);
				};
				if (this.loads.size >= this.capacity) {
					for (const [k, entry] of this.loads)
						if (!entry.lease || entry.lease.deadline <= Date.now()) evict(k);
					if (this.loads.size >= this.capacity) evict(this.loads.keys().next().value!);
				}
				slot = { cleared: false };
				this.loads.set(key, slot);
			}
			slot.lease = marker;
			try {
				const result = await load();
				if (this.loads.get(key) === slot && slot.lease === marker) {
					const ms = ttl?.(result);
					if (ms === undefined || ms > 0) this.values.set(key, result, ms);
					// Waiters retain the result; expired slots are reclaimable at
					// capacity rather than occupying a live lease for its full TTL.
					else {
						marker.settled = { value: result };
						marker.deadline = 0;
					}
				}
				return result;
			} finally {
				// Keep the key's invalidation flag reachable until its slot is
				// reclaimed, including across a later, positively cached fill.
				if (this.loads.get(key) === slot && slot.lease === marker && !marker.settled)
					slot.lease = undefined;
			}
		}
	}
}
