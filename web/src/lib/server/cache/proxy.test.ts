import { describe, expect, it } from 'vitest';
import { pickWinner, proxyKeyName, readableCacheSet } from './proxy';
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

describe('readableCacheSet', () => {
	it('anonymous sees only public caches', () => {
		expect([...readableCacheSet(null, rows).keys()]).toEqual(['public-a']);
	});
	it('a pull token widens the set by its patterns', () => {
		const set = readableCacheSet(tokenWith({ 'private-*': { pull: true } }), rows);
		expect([...set.keys()].sort()).toEqual(['private-b', 'private-c', 'public-a']);
	});
	it('non-pull bits do not grant read', () => {
		const set = readableCacheSet(tokenWith({ 'private-b': { push: true } }), rows);
		expect([...set.keys()]).toEqual(['public-a']);
	});
});

describe('pickWinner', () => {
	const readable = readableCacheSet(tokenWith({ '*': { pull: true } }), rows);
	it('orders by priority then name', () => {
		expect(pickWinner(['public-a', 'private-c', 'private-b'], readable)?.name).toBe('private-b');
	});
	it('ignores unreadable candidates', () => {
		const anon = readableCacheSet(null, rows);
		expect(pickWinner(['private-b', 'public-a'], anon)?.name).toBe('public-a');
		expect(pickWinner(['private-b'], anon)).toBeNull();
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
