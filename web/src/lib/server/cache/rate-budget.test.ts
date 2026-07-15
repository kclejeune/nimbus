import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateBudget } from './rate-budget';

describe('RateBudget', () => {
	afterEach(() => vi.useRealTimers());

	it('spends up to the limit, then refuses until the window rolls', () => {
		vi.useFakeTimers();
		const b = new RateBudget(60_000);
		expect(b.tryTake(2)).toBe(true);
		expect(b.tryTake(2)).toBe(true);
		expect(b.tryTake(2)).toBe(false);
		vi.advanceTimersByTime(59_000);
		expect(b.tryTake(2)).toBe(false);
		vi.advanceTimersByTime(1_001);
		expect(b.tryTake(2)).toBe(true);
	});

	it('applies the per-call limit against the running window counter', () => {
		vi.useFakeTimers();
		const b = new RateBudget(60_000);
		expect(b.tryTake(1)).toBe(true);
		// A raised limit mid-window opens headroom; a lowered one closes it.
		expect(b.tryTake(3)).toBe(true);
		expect(b.tryTake(2)).toBe(false);
	});
});
