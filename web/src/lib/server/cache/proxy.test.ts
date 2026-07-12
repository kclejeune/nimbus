import { describe, expect, it } from 'vitest';
import { pickReadableWinner, proxyKeyName } from './proxy';
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
	return { caches: map, gc: false };
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
