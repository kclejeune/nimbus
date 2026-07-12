import { describe, expect, it } from 'vitest';
import { mintAtticToken } from './attic-token';
import { verifyAtticToken } from './attic/token';

const SECRET = btoa('0123456789abcdef0123456789abcdef');

describe('mintAtticToken', () => {
	it('roundtrips cache claims and jti through mint + verify', async () => {
		const jwt = await mintAtticToken(SECRET, 'user-1', { '*': { r: 1 } }, 300, 'jti-1');
		const verified = await verifyAtticToken(jwt, { hs256SecretBase64: SECRET });
		expect(verified.jti).toBe('jti-1');
		expect(verified.caches.get('*')?.pull).toBe(true);
	});

	it('roundtrips the nimbus gc claim', async () => {
		const jwt = await mintAtticToken(SECRET, 'user-1', { '*': {} }, 300, 'jti-2', { gc: 1 });
		const verified = await verifyAtticToken(jwt, { hs256SecretBase64: SECRET });
		expect(verified.gc).toBe(true);
	});

	it('omits the nimbus namespace when no global claims are given', async () => {
		const jwt = await mintAtticToken(SECRET, 'user-1', { foo: { w: 1 } });
		const verified = await verifyAtticToken(jwt, { hs256SecretBase64: SECRET });
		expect(verified.gc).toBe(false);
	});
});
