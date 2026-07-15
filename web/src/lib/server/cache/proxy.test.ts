import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearAbsent,
	isKnownAbsent,
	pickReadableWinner,
	proxyKeyName,
	recordAbsent,
	shouldTouch
} from './proxy';
import type { VerifiedToken, Permission } from '../attic/token';
import { NO_PERMISSION } from '../attic/token';

const rows = [
	{ name: 'public-a', priority: 40, is_public: 1 },
	{ name: 'private-b', priority: 30, is_public: 0 },
	{ name: 'private-c', priority: 30, is_public: 0 }
];

function tokenWith(caches: Record<string, Partial<Permission>>): VerifiedToken {
	const map = new Map<string, Permission>();
	for (const [k, v] of Object.entries(caches)) map.set(k, { ...NO_PERMISSION, ...v });
	return { caches: map, gc: false, ct: false };
}

describe('pickReadableWinner', () => {
	it('anonymous resolves only against public caches', () => {
		expect(pickReadableWinner(null, rows)?.name).toBe('public-a');
		expect(pickReadableWinner(null, [rows[1]])).toBeNull();
	});
	it('a pull token widens the readable set by its patterns', () => {
		expect(pickReadableWinner(tokenWith({ 'private-*': { pull: true } }), rows)?.name).toBe(
			'private-b'
		);
	});
	it('non-pull bits do not grant read', () => {
		expect(pickReadableWinner(tokenWith({ 'private-b': { push: true } }), rows)?.name).toBe(
			'public-a'
		);
	});
	it('orders by priority then name', () => {
		const all = tokenWith({ '*': { pull: true } });
		expect(pickReadableWinner(all, rows)?.name).toBe('private-b');
		expect(pickReadableWinner(all, [rows[0], rows[2]])?.name).toBe('private-c');
	});
});

describe('absent-path memo', () => {
	afterEach(() => {
		vi.useRealTimers();
		clearAbsent('h1');
	});

	it('remembers absence until the TTL elapses', () => {
		vi.useFakeTimers();
		expect(isKnownAbsent('h1')).toBe(false);
		recordAbsent('h1');
		expect(isKnownAbsent('h1')).toBe(true);
		vi.advanceTimersByTime(61_000);
		expect(isKnownAbsent('h1')).toBe(false);
	});

	it('is cleared when an upload lands the path', () => {
		recordAbsent('h1');
		clearAbsent('h1');
		expect(isKnownAbsent('h1')).toBe(false);
	});
});

describe('download-touch coalescing', () => {
	// Fresh NAR key per test so the per-isolate memo never carries across cases
	// (Date.now() is frozen under fake timers, so it can't provide uniqueness).
	let seq = 0;
	const freshNar = () => `nar-${seq++}`;
	afterEach(() => vi.useRealTimers());

	it('touches once per window, then again after it elapses', () => {
		vi.useFakeTimers();
		const nar = freshNar();
		expect(shouldTouch('cache-a', nar)).toBe(true);
		// Repeats within the window are suppressed.
		expect(shouldTouch('cache-a', nar)).toBe(false);
		expect(shouldTouch('cache-a', nar)).toBe(false);
		// The window is 5 minutes; just under it still suppresses.
		vi.advanceTimersByTime(4 * 60_000);
		expect(shouldTouch('cache-a', nar)).toBe(false);
		// Past the window it touches again.
		vi.advanceTimersByTime(61_000);
		expect(shouldTouch('cache-a', nar)).toBe(true);
	});

	it('keys per cache so the same NAR touches each cache independently', () => {
		vi.useFakeTimers();
		const nar = freshNar();
		expect(shouldTouch('cache-x', nar)).toBe(true);
		// Different cache, same NAR hash: not suppressed by cache-x's entry.
		expect(shouldTouch('cache-y', nar)).toBe(true);
		expect(shouldTouch('cache-x', nar)).toBe(false);
	});
});

describe('proxyKeyName', () => {
	it('derives from CACHE_BASE_URL host', () => {
		expect(proxyKeyName({ CACHE_BASE_URL: 'https://cache.kclj.io' } as never)).toBe(
			'cache.kclj.io-1'
		);
	});
	it('falls back when unset', () => {
		expect(proxyKeyName({} as never)).toBe('nimbus-proxy-1');
	});
});
