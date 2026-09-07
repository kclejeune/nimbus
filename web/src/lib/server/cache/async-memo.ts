import { sleep } from './platform';
import { TtlMemo } from './ttl-memo';

/** Share values, never request-owned I/O promises. Abandoned leaders expire. */
export class AsyncMemo<V> {
	private readonly values: TtlMemo<V>;
	private readonly loads = new Map<string, { deadline: number }>();
	constructor(
		ttl: number,
		private readonly capacity: number
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
		for (;;) {
			const value = this.values.get(key);
			if (value !== undefined) return value;
			const active = this.loads.get(key);
			if (active && active.deadline > Date.now()) {
				await sleep(interval + Math.random() * interval);
				interval = Math.min(20, interval * 2);
				continue;
			}
			const marker = { deadline: Date.now() + 2_000 };
			if (this.loads.size >= this.capacity) {
				for (const [k, m] of this.loads) if (m.deadline <= Date.now()) this.loads.delete(k);
				if (this.loads.size >= this.capacity) this.loads.delete(this.loads.keys().next().value!);
			}
			this.loads.set(key, marker);
			try {
				const result = await load();
				if (this.loads.get(key) === marker) this.values.set(key, result, ttl?.(result));
				return result;
			} finally {
				if (this.loads.get(key) === marker) this.loads.delete(key);
			}
		}
	}
}
