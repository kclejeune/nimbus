// Value-only, per-isolate backoff for speculative reads. Foreground reads,
// retries and consistency-required confirmations retain their own policies.
const OVERLOAD_COOLDOWN_MS = 2_000;
let overloadedUntil = 0;

export function isD1Overload(error: unknown): boolean {
	return /\boverloaded\b|queued for too long/i.test(
		error instanceof Error ? error.message : String(error)
	);
}

export function noteD1Overload(error: unknown): void {
	if (isD1Overload(error))
		overloadedUntil = Math.max(overloadedUntil, Date.now() + OVERLOAD_COOLDOWN_MS);
}

export function d1OverloadDelay(): number {
	return Math.max(0, overloadedUntil - Date.now());
}
