import { describe, expect, it } from 'vitest';
import { decodeJwtClaims, diffGroupSync, extractGroups, shouldAutoActivate } from './group-sync';

function fakeJwt(payload: object): string {
	const b64 = btoa(JSON.stringify(payload))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `eyJhbGciOiJub25lIn0.${b64}.sig`;
}

describe('decodeJwtClaims', () => {
	it('decodes the payload without verifying', () => {
		expect(decodeJwtClaims(fakeJwt({ groups: ['a'] }))).toEqual({ groups: ['a'] });
	});
	it('returns null on garbage', () => {
		expect(decodeJwtClaims('not-a-jwt')).toBeNull();
	});
});

describe('extractGroups', () => {
	it('reads string arrays and single strings', () => {
		expect(extractGroups({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
		expect(extractGroups({ groups: 'a' }, 'groups')).toEqual(['a']);
	});
	it('returns null when the claim is absent (skip sync), [] when empty', () => {
		expect(extractGroups({ other: 1 }, 'groups')).toBeNull();
		expect(extractGroups(null, 'groups')).toBeNull();
		expect(extractGroups({ groups: [] }, 'groups')).toEqual([]);
	});
	it('drops non-string members', () => {
		expect(extractGroups({ groups: ['a', 5, null] }, 'groups')).toEqual(['a']);
	});
});

describe('diffGroupSync', () => {
	const mapped = [
		{ id: 'g1', oidcGroup: 'devs' },
		{ id: 'g2', oidcGroup: 'ops' }
	];
	it('adds mapped groups present in the claim, removes stale sso rows', () => {
		expect(diffGroupSync(mapped, ['devs'], ['g2'])).toEqual({ add: ['g1'], remove: ['g2'] });
	});
	it('is a no-op when membership matches', () => {
		expect(diffGroupSync(mapped, ['devs'], ['g1'])).toEqual({ add: [], remove: [] });
	});
	it('removes sso rows for unmapped groups (mapping deleted later)', () => {
		expect(diffGroupSync([], [], ['g9'])).toEqual({ add: [], remove: ['g9'] });
	});
	it('ignores unmapped claim values', () => {
		expect(diffGroupSync(mapped, ['strangers'], [])).toEqual({ add: [], remove: [] });
	});
});

describe('shouldAutoActivate', () => {
	it('requires both a configured group and a present claim', () => {
		expect(shouldAutoActivate(['nimbus_user'], 'nimbus_user')).toBe(true);
		expect(shouldAutoActivate(['other'], 'nimbus_user')).toBe(false);
		expect(shouldAutoActivate([], 'nimbus_user')).toBe(false);
		expect(shouldAutoActivate(null, 'nimbus_user')).toBe(false);
		expect(shouldAutoActivate(['nimbus_user'], undefined)).toBe(false);
		expect(shouldAutoActivate(['nimbus_user'], '')).toBe(false);
	});
});
