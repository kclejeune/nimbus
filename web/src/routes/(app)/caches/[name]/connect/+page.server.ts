import { error } from '@sveltejs/kit';
import { allLiveUpstreams, upstreamsForCache } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { canSeeCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
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

	const [cache, access] = await Promise.all([
		db
			.prepare(
				'SELECT id, name, is_public, keypair FROM cache WHERE name = ?1 AND deleted_at IS NULL'
			)
			.bind(params.name)
			.first<{ id: number; name: string; is_public: number; keypair: string }>(),
		effectiveAccessOf(locals, db)
	]);
	if (!cache) throw error(404, `Cache "${params.name}" not found`);
	if (!canSeeCache(access, params.name)) throw error(403, 'Permission denied');

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
