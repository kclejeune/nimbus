// A per-isolate rate budget: a fixed window with a spend counter, for
// bounding speculative fan-out (reference prefetch) no matter how many
// triggering requests race. Deliberately not a smooth token bucket — the
// consumers only need "no more than N per window per isolate", and a hard
// window is simpler to reason about when tuning N against D1 load.
export class RateBudget {
	private windowStart = 0;
	private spent = 0;

	constructor(private readonly windowMs: number) {}

	/** Spend one unit against `limit` per window; false when exhausted. The
	 * limit is per-call so env-configured values apply without rebuilding the
	 * budget (the counter carries across limit changes within a window). */
	tryTake(limit: number): boolean {
		const now = Date.now();
		if (now - this.windowStart >= this.windowMs) {
			this.windowStart = now;
			this.spent = 0;
		}
		if (this.spent >= limit) return false;
		this.spent += 1;
		return true;
	}
}
