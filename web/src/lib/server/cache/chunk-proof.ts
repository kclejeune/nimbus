import { SignJWT, jwtVerify } from 'jose';
import { cachedKeyImport } from '../attic/signing';

type Env = App.Platform['env'];
const AUDIENCE = 'nimbus:chunk-proof';

// One HMAC key import per isolate and secret: receipts are verified per
// chunk, and re-encoding and re-importing the secret for each of a large
// NAR's thousands of chunks dominated the query and completion handlers.
const keys = new Map<string, Promise<CryptoKey>>();
function key(env: Env, cache: { keypair: string | null }): Promise<CryptoKey> {
	const secret = env.JWT_HS256_SECRET_BASE64 || env.SESSION_SECRET || cache.keypair;
	if (!secret) throw new Error('Chunk receipts require a signing secret');
	// Only the per-cache keypair fallback can vary per call; bound it.
	if (keys.size >= 1024) keys.clear();
	return cachedKeyImport(keys, `nimbus:chunk-proof:v1:${secret}`, (material) =>
		crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(material),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		)
	);
}

export async function issueChunkProof(
	env: Env,
	cache: { id: number; keypair: string | null },
	hash: string,
	size: number
): Promise<string> {
	return new SignJWT({ cache: cache.id, hash, size })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience(AUDIENCE)
		.setExpirationTime('24h')
		.sign(await key(env, cache));
}

export async function verifyChunkProof(
	env: Env,
	cache: { id: number; keypair: string | null },
	chunk: { hash: string; size: number; proof?: string }
): Promise<boolean> {
	if (!chunk.proof) return false;
	try {
		const { payload } = await jwtVerify(chunk.proof, await key(env, cache), {
			algorithms: ['HS256'],
			audience: AUDIENCE
		});
		return payload.cache === cache.id && payload.hash === chunk.hash && payload.size === chunk.size;
	} catch {
		return false;
	}
}
