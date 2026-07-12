import { describe, expect, it } from 'vitest';
import {
	ADMIN_ACCESS,
	canOnCache,
	canSeeCache,
	partitionCacheGrants,
	scopeDenial,
	tokenScopeOptions,
	unionAccess
} from './permissions';

const grants = (rows: [string, object][]) =>
	unionAccess(rows.map(([pattern, actions]) => ({ pattern, actions: JSON.stringify(actions) })));

describe('unionAccess', () => {
	it('ORs bits across grants with the same pattern', () => {
		const a = grants([
			['ci-*', { r: 1 }],
			['ci-*', { w: 1 }]
		]);
		expect(a.caches['ci-*']).toEqual({ r: 1, w: 1 });
		expect(a.gc).toBe(false);
	});

	it('keeps distinct patterns distinct and extracts gc', () => {
		const a = grants([
			['nixos', { r: 1 }],
			['*', { gc: 1 }]
		]);
		expect(a.caches['nixos']).toEqual({ r: 1 });
		expect(a.caches['*']).toEqual({});
		expect(a.gc).toBe(true);
	});

	it('skips malformed action JSON', () => {
		const a = unionAccess([{ pattern: 'x', actions: 'not-json' }]);
		expect(a.caches).toEqual({});
	});
});

describe('canOnCache', () => {
	const a = grants([
		['ci-*', { w: 1 }],
		['ci-build', { r: 1 }]
	]);
	it('ORs the exact entry with every matching glob', () => {
		expect(canOnCache(a, 'r', 'ci-build')).toBe(true);
		expect(canOnCache(a, 'w', 'ci-build')).toBe(true);
		expect(canOnCache(a, 'w', 'ci-deploy')).toBe(true);
		expect(canOnCache(a, 'r', 'ci-deploy')).toBe(false);
		expect(canOnCache(a, 'w', 'prod')).toBe(false);
	});
});

describe('canSeeCache', () => {
	const a = grants([['ci-*', { w: 1 }]]);
	it('public caches are always visible; private need any bit', () => {
		expect(canSeeCache(a, 'anything', true)).toBe(true);
		expect(canSeeCache(a, 'ci-build', false)).toBe(true);
		expect(canSeeCache(a, 'prod', false)).toBe(false);
	});
});

describe('scopeDenial', () => {
	const a = grants([
		['ci-*', { r: 1, w: 1 }],
		['prod', { r: 1 }]
	]);
	it('allows concrete names covered by globs', () => {
		expect(scopeDenial(a, { pattern: 'ci-build', bits: { r: 1, w: 1 } })).toBeNull();
	});
	it('rejects uncovered bits on concrete names', () => {
		expect(scopeDenial(a, { pattern: 'prod', bits: { w: 1 } })).toMatch(/w/);
	});
	it('allows a wildcard scope only as an exact grant pattern', () => {
		expect(scopeDenial(a, { pattern: 'ci-*', bits: { w: 1 } })).toBeNull();
		expect(scopeDenial(a, { pattern: 'ci-b*', bits: { w: 1 } })).not.toBeNull();
		expect(scopeDenial(a, { pattern: '*', bits: { r: 1 } })).not.toBeNull();
	});
	it('a * grant widens wildcard scopes', () => {
		const star = grants([['*', { r: 1 }]]);
		expect(scopeDenial(star, { pattern: 'ci-*', bits: { r: 1 } })).toBeNull();
	});
	it('gates gc and empty scopes', () => {
		expect(scopeDenial(a, { pattern: 'prod', bits: {}, gc: true })).toMatch(/garbage/i);
		expect(scopeDenial(a, { pattern: 'prod', bits: {} })).toMatch(/at least one/i);
		expect(scopeDenial(ADMIN_ACCESS, { pattern: '*', bits: { d: 1 }, gc: true })).toBeNull();
	});
});

describe('partitionCacheGrants', () => {
	const row = (id: string, pattern: string) => ({
		id,
		subject_type: 'user',
		subject_id: 'u1',
		pattern,
		actions: '{"r":1}'
	});
	it('splits exact-name rows from matching globs and drops non-matches', () => {
		const { direct, viaPatterns } = partitionCacheGrants(
			[row('a', 'henry'), row('b', 'hen*'), row('c', 'riley'), row('d', '*')],
			'henry'
		);
		expect(direct.map((g) => g.id)).toEqual(['a']);
		expect(viaPatterns.map((g) => g.id)).toEqual(['b', 'd']);
	});
});

describe('tokenScopeOptions', () => {
	it('offers grant patterns plus covered concrete names, deduped and sorted', () => {
		const a = grants([['ci-*', { r: 1, w: 1 }]]);
		const opts = tokenScopeOptions(a, ['ci-build', 'prod', 'ci-*']);
		expect(opts.map((o) => o.value)).toEqual(['ci-*', 'ci-build']);
		expect(opts[1].bits).toEqual({ r: 1, w: 1 });
	});
	it('admin sees * plus everything', () => {
		const opts = tokenScopeOptions(ADMIN_ACCESS, ['a', 'b']);
		expect(opts.map((o) => o.value)).toEqual(['*', 'a', 'b']);
	});
});
