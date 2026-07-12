import { describe, expect, it } from 'vitest';
import { mintScopedToken } from './tokens';
import { verifyAtticToken } from './attic/token';

const SECRET = btoa('0123456789abcdef0123456789abcdef');

describe('mintScopedToken', () => {
	it('carries the requested bits', async () => {
		const minted = await mintScopedToken(SECRET, 'u1', {
			cacheScope: 'ci-*',
			bits: { r: 1, w: 1, cd: 1 },
			days: 1
		});
		const verified = await verifyAtticToken(minted.token, { hs256SecretBase64: SECRET });
		const perm = verified.caches.get('ci-*')!;
		expect(perm.pull).toBe(true);
		expect(perm.push).toBe(true);
		expect(perm.destroyCache).toBe(true);
		expect(perm.delete).toBe(false);
		expect(verified.jti).toBe(minted.jti);
		expect(verified.gc).toBe(false);
	});

	it('carries the gc claim for a gc-only token', async () => {
		const minted = await mintScopedToken(SECRET, 'u1', {
			cacheScope: '*',
			bits: {},
			gc: true,
			days: 1
		});
		const verified = await verifyAtticToken(minted.token, { hs256SecretBase64: SECRET });
		expect(verified.gc).toBe(true);
		expect(verified.caches.get('*')?.delete).toBe(false);
	});
});
