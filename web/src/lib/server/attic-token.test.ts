import { describe, expect, it } from 'vitest';
import { mintAtticToken, NIMBUS_CLAIM_NAMESPACE } from './attic-token';
import { verifyAtticToken } from './attic/token';

const SECRET = btoa('0123456789abcdef0123456789abcdef');

describe('nimbus global claim', () => {
	it('roundtrips gc through mint + verify', async () => {
		const jwt = await mintAtticToken(SECRET, 'user-1', { '*': { r: 1 } }, 300, 'jti-1', { gc: 1 });
		const verified = await verifyAtticToken(jwt, { hs256SecretBase64: SECRET });
		expect(verified.gc).toBe(true);
		expect(verified.jti).toBe('jti-1');
		expect(verified.caches.get('*')?.pull).toBe(true);
	});

	it('omits the nimbus namespace when no global claims are given', async () => {
		const jwt = await mintAtticToken(SECRET, 'user-1', { foo: { w: 1 } });
		const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(payload[NIMBUS_CLAIM_NAMESPACE]).toBeUndefined();
		const verified = await verifyAtticToken(jwt, { hs256SecretBase64: SECRET });
		expect(verified.gc).toBe(false);
	});
});
