import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlMemo } from './ttl-memo';

describe('TtlMemo', () => {
	afterEach(() => vi.useRealTimers());

	it('returns a stored value until its TTL elapses', () => {
		vi.useFakeTimers();
		const m = new TtlMemo<number>(1000, 100);
		m.set('a', 7);
		expect(m.get('a')).toBe(7);
		vi.advanceTimersByTime(999);
		expect(m.get('a')).toBe(7);
		vi.advanceTimersByTime(2);
		expect(m.get('a')).toBeUndefined();
	});

	it('distinguishes a stored falsy value from an absent key', () => {
		const m = new TtlMemo<boolean>(1000, 100);
		expect(m.get('x')).toBeUndefined();
		m.set('x', false);
		expect(m.get('x')).toBe(false);
	});

	it('per-set TTL overrides the default', () => {
		vi.useFakeTimers();
		const m = new TtlMemo<string>(1000, 100);
		m.set('short', 'v', 100);
		vi.advanceTimersByTime(200);
		expect(m.get('short')).toBeUndefined();
	});

	it('delete drops one key; clear drops all', () => {
		const m = new TtlMemo<number>(1000, 100);
		m.set('a', 1);
		m.set('b', 2);
		m.delete('a');
		expect(m.get('a')).toBeUndefined();
		expect(m.get('b')).toBe(2);
		m.clear();
		expect(m.get('b')).toBeUndefined();
	});

	it('at capacity, sweeps expired entries instead of wiping live ones', () => {
		vi.useFakeTimers();
		const m = new TtlMemo<number>(1000, 2);
		m.set('old', 1, 100); // expires first
		m.set('live', 2, 10_000);
		// 'old' has expired; inserting a third key hits the cap and should
		// reclaim it via the sweep, keeping 'live'.
		vi.advanceTimersByTime(200);
		m.set('new', 3);
		expect(m.get('live')).toBe(2);
		expect(m.get('new')).toBe(3);
		expect(m.get('old')).toBeUndefined();
	});

	it('wipes wholesale only when nothing is expired at capacity', () => {
		const m = new TtlMemo<number>(10_000, 2);
		m.set('a', 1);
		m.set('b', 2);
		// Both live; the third insert cannot reclaim by sweep, so it clears.
		m.set('c', 3);
		expect(m.get('a')).toBeUndefined();
		expect(m.get('b')).toBeUndefined();
		expect(m.get('c')).toBe(3);
	});
});
