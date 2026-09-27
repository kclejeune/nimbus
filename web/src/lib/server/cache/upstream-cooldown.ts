interface Health {
	failures: number;
	delay: number;
	until: number;
	probeUntil: number;
	generation: number;
}

/** Transient failures are health information, never cached path absences.
 * Values and leases only: no request-owned promises cross Workers contexts. */
export class UpstreamCooldown {
	private states = new Map<string, Health>();
	clear(): void {
		this.states.clear();
	}

	/** `unavailable` is both the op's failure result and what a cooling-down
	 * upstream returns without running op; anything else counts as healthy. */
	async run<T>(
		key: string,
		op: () => Promise<T>,
		unavailable: T,
		cancelled = () => false
	): Promise<T> {
		let state = this.states.get(key);
		if (!state) {
			if (this.states.size >= 256) this.states.delete(this.states.keys().next().value!);
			state = { failures: 0, delay: 15_000, until: 0, probeUntil: 0, generation: 0 };
			this.states.set(key, state);
		}
		const now = Date.now();
		if (state.until > now || state.probeUntil > now) return unavailable;
		const recovering = state.until !== 0;
		if (recovering) {
			state.probeUntil = now + 6_000;
			state.generation++;
		}
		const generation = state.generation;
		let healthy = false;
		try {
			const value = await op();
			healthy = value !== unavailable;
			return value;
		} finally {
			// A late in-flight success must not close a newer failed recovery probe.
			if (this.states.get(key) === state && state.generation === generation) {
				state.probeUntil = 0;
				if (healthy) this.states.delete(key);
				else if (!cancelled() && (recovering || ++state.failures >= 3)) {
					if (recovering) state.delay = Math.min(60_000, state.delay * 2);
					state.until = Date.now() + state.delay;
					state.generation++;
				}
			}
		}
	}
}
