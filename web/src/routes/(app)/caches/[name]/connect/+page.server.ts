import { error } from '@sveltejs/kit';
import { allLiveUpstreams, upstreamsForCache } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { requireCacheBrowse } from '$lib/server/cache/cache-page';
import type { PageServerLoad } from './$types';

/** The Nix trusted-key form of the cache keypair, or null when malformed. */
function derivePublicKey(keypair: string): string | null {
	try {
		return extractPublicKey(keypair);
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ platform, params, locals }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// Anyone may pull a public cache, so anyone may see how to.
	const { cache } = await requireCacheBrowse(locals, db, params.name);

	const cacheBase = (platform?.env.CACHE_BASE_URL ?? 'https://cache.kclj.io').replace(/\/$/, '');
	const [proxyPublicKey, cacheUpstreams, proxyUpstreams] = await Promise.all([
		getProxyKeypair(platform.env)
			.then(extractPublicKey)
			.catch(() => null),
		upstreamsForCache(db, { id: cache.id, name: cache.name }),
		allLiveUpstreams(db)
	]);
	const upstreamRef = (u: { url: string; publicKey: string | null; nixDefault: boolean }) => ({
		url: u.url,
		publicKey: u.publicKey,
		nixDefault: u.nixDefault
	});

	return {
		cache: {
			name: cache.name,
			isPublic: cache.is_public !== 0,
			url: `${cacheBase}/${cache.name}`,
			publicKey: derivePublicKey(cache.keypair)
		},
		cacheBase,
		// The nix.conf snippets carry these: keys always (redirect-tier paths
		// keep their upstream signatures), URLs behind the checkbox.
		upstreams: cacheUpstreams.map(upstreamRef),
		proxy: proxyPublicKey
			? { url: cacheBase, publicKey: proxyPublicKey, upstreams: proxyUpstreams.map(upstreamRef) }
			: null
	};
};
