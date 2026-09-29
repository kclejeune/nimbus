import { error } from '@sveltejs/kit';
import { readGcLastRun } from '$lib/server/cache/gc';
import { allLiveUpstreams } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { readSession } from '$lib/server/cache/db';
import { instanceStatsSnapshot } from '$lib/server/cache/stats';
import { canBrowseCache } from '$lib/server/auth/permissions';
import { effectiveAccessOf } from '$lib/server/auth/guard';
import { listUserTokens } from '$lib/server/tokens';
import type { PageServerLoad } from './$types';

export interface AttentionItem {
	tone: 'warning' | 'danger' | 'neutral';
	title: string;
	detail: string;
	href: string;
	action: string;
}

const DAY_S = 86400;
/** GC runs nightly (03:00 UTC); a gap past this means a missed run. */
const GC_OVERDUE_MS = 36 * 3600_000;
const TOKEN_WARN_DAYS = 14;
const BUDGET_WARN = 0.9;

export const load: PageServerLoad = async ({ platform, locals, parent }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');
	const user = locals.user!;
	const isAdmin = user.role === 'admin';

	// Read-only dashboard (the GC and limit actions live on /settings), so
	// everything reads a replica session.
	const read = readSession(db);

	const [
		globalLimit,
		gcLastRun,
		proxyPublicKey,
		proxyUpstreams,
		{ results: caches },
		access,
		tokens,
		progress,
		{ pendingUsers }
	] = await Promise.all([
		read
			.prepare("SELECT value FROM server_config WHERE key = 'global_max_bytes'")
			.first<{ value: string }>(),
		readGcLastRun(read),
		platform?.env
			? getProxyKeypair(platform.env)
					.then(extractPublicKey)
					.catch(() => null)
			: null,
		allLiveUpstreams(read),
		read
			.prepare(
				`SELECT id, name, is_public, retention_max_bytes FROM cache
				 WHERE deleted_at IS NULL ORDER BY name`
			)
			.all<{ id: number; name: string; is_public: number; retention_max_bytes: number | null }>(),
		effectiveAccessOf(locals, db),
		listUserTokens(db, user.id),
		// Live (not the GC snapshot) so getting-started steps tick off right away.
		read
			.prepare(
				`SELECT EXISTS (SELECT 1 FROM cache WHERE deleted_at IS NULL) AS has_cache,
				        EXISTS (SELECT 1 FROM object o JOIN cache c ON c.id = o.cache_id
				                WHERE c.deleted_at IS NULL) AS has_push`
			)
			.first<{ has_cache: number; has_push: number }>(),
		parent()
	]);

	const { stats, statsAt } = await instanceStatsSnapshot(read, gcLastRun);
	const globalMaxBytes = globalLimit ? Number(globalLimit.value) : null;

	const inScope = caches.filter((c) =>
		canBrowseCache(access, { name: c.name, isPublic: c.is_public !== 0 })
	);
	const ids = inScope.map((c) => c.id);
	const budgeted = inScope.filter((c) => c.retention_max_bytes);

	// Recent pushes and budget usage are scoped to caches this viewer can
	// browse; an empty IN () is invalid SQL, so empty scopes skip the query.
	const [recent, budgetBytes] = await Promise.all([
		ids.length === 0
			? []
			: read
					.prepare(
						`SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size, c.name AS cache_name
						 FROM object o
						 JOIN cache c ON c.id = o.cache_id
						 JOIN nar n ON n.id = o.nar_id
						 WHERE o.cache_id IN (${ids.map(() => '?').join(', ')})
						 ORDER BY o.created_at DESC LIMIT 6`
					)
					.bind(...ids)
					.all<{
						store_path: string;
						store_path_hash: string;
						created_at: string;
						nar_size: number;
						cache_name: string;
					}>()
					.then((r) => r.results),
		budgeted.length === 0
			? new Map<number, number>()
			: (() => {
					// Same accounting as /caches: a NAR shared by several paths in one
					// cache counts once. Only caches with a budget are scanned.
					const inList = budgeted.map(() => '?').join(', ');
					return read
						.prepare(
							`SELECT o.cache_id, COALESCE(SUM(sz.bytes), 0) AS bytes
							 FROM (SELECT DISTINCT cache_id, nar_id FROM object
							       WHERE cache_id IN (${inList})) o
							 JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr
							       JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz
							   ON sz.nar_id = o.nar_id
							 GROUP BY o.cache_id`
						)
						.bind(...budgeted.map((c) => c.id))
						.all<{ cache_id: number; bytes: number }>()
						.then((r) => new Map(r.results.map((x) => [x.cache_id, x.bytes])));
				})()
	]);

	// --- Needs attention: each item names the fix and links straight to it. ---
	const attention: AttentionItem[] = [];
	const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

	if (isAdmin && pendingUsers > 0) {
		attention.push({
			tone: 'warning',
			title: `${plural(pendingUsers, 'person is', 'people are')} waiting for access`,
			detail: 'They signed in but can’t use nimbus until an admin activates them.',
			href: '/users',
			action: 'Review users'
		});
	}
	const incomplete = gcLastRun?.integrity?.incompleteObjects ?? 0;
	if (isAdmin && incomplete > 0) {
		attention.push({
			tone: 'danger',
			title: `${plural(incomplete, 'store path has', 'store paths have')} incomplete closures`,
			detail:
				'Their references are missing from every cache and upstream, so Nix may fail to substitute them.',
			href: '/settings',
			action: 'See affected paths'
		});
	}
	if (isAdmin && progress?.has_push) {
		const last = gcLastRun ? Date.parse(gcLastRun.at) : NaN;
		if (!gcLastRun || Date.now() - last > GC_OVERDUE_MS) {
			attention.push({
				tone: 'warning',
				title: gcLastRun
					? 'Nightly garbage collection is overdue'
					: 'Garbage collection hasn’t run yet',
				detail: gcLastRun
					? 'The scheduled run was missed, so expired paths and unused storage are piling up.'
					: 'It runs nightly on its own; run it now to get storage totals right away.',
				href: '/settings',
				action: 'Open garbage collection'
			});
		}
	}
	if (isAdmin && globalMaxBytes && stats.storageBytes >= globalMaxBytes * BUDGET_WARN) {
		attention.push({
			tone: stats.storageBytes >= globalMaxBytes ? 'danger' : 'warning',
			title: `Storage is at ${Math.round((stats.storageBytes / globalMaxBytes) * 100)}% of the instance limit`,
			detail: 'Past the limit, the least recently used closures are evicted from every cache.',
			href: '/settings',
			action: 'Adjust limit'
		});
	}
	for (const c of budgeted) {
		const bytes = budgetBytes.get(c.id) ?? 0;
		const pct = bytes / c.retention_max_bytes!;
		if (pct < BUDGET_WARN) continue;
		attention.push({
			tone: pct >= 1 ? 'danger' : 'warning',
			title: `${c.name} is at ${Math.round(pct * 100)}% of its size budget`,
			detail: 'Its least recently used closures are evicted once it goes over.',
			href: `/caches/${encodeURIComponent(c.name)}/settings`,
			action: 'Review retention'
		});
	}
	const now = Math.floor(Date.now() / 1000);
	const expiring = tokens.filter(
		(t) => t.status === 'active' && t.expiresAt && t.expiresAt - now < TOKEN_WARN_DAYS * DAY_S
	);
	if (expiring.length > 0) {
		const soonest = Math.min(...expiring.map((t) => t.expiresAt!));
		const days = Math.max(0, Math.ceil((soonest - now) / DAY_S));
		attention.push({
			tone: 'neutral',
			title:
				expiring.length === 1
					? `Your token “${expiring[0].name}” expires ${days === 0 ? 'today' : `in ${plural(days, 'day')}`}`
					: `${expiring.length} of your tokens expire within ${TOKEN_WARN_DAYS} days`,
			detail: 'Create a replacement and update wherever it’s stored before it stops working.',
			href: '/tokens',
			action: 'Manage tokens'
		});
	}

	return {
		stats,
		statsAt,
		globalMaxBytes,
		gcLastRun,
		attention,
		onboarding: {
			hasCache: Boolean(progress?.has_cache),
			hasToken: tokens.length > 0,
			hasPush: Boolean(progress?.has_push),
			firstCache: inScope[0]?.name ?? null
		},
		recent: recent.map((r) => ({
			storePath: r.store_path,
			hash: r.store_path_hash,
			createdAt: r.created_at,
			narSize: r.nar_size,
			cache: r.cache_name
		})),
		cacheBaseUrl: platform?.env.CACHE_BASE_URL ?? null,
		appUrl: platform?.env.APP_URL ?? null,
		proxyPublicKey,
		proxyUpstreams: proxyUpstreams.map((u) => ({
			url: u.url,
			publicKey: u.publicKey,
			nixDefault: u.nixDefault
		}))
	};
};
