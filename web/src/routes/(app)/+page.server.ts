import { error } from '@sveltejs/kit';
import { cacheSizes, readGcLastRun, readGlobalMaxBytes } from '$lib/server/cache/gc';
import { allLiveUpstreams } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { readSession } from '$lib/server/cache/db';
import { instanceStatsSnapshot } from '$lib/server/cache/stats';
import { canOnCache } from '$lib/server/auth/permissions';
import { browsableCaches } from '$lib/server/cache/cache-page';
import { listUserTokens } from '$lib/server/tokens';
import { plural } from '$lib/format';
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
		globalMaxBytes,
		gcLastRun,
		proxyPublicKey,
		proxyUpstreams,
		{ caches: inScope, access },
		tokens,
		{ pendingUsers }
	] = await Promise.all([
		readGlobalMaxBytes(read),
		readGcLastRun(read),
		platform?.env
			? getProxyKeypair(platform.env)
					.then(extractPublicKey)
					.catch(() => null)
			: null,
		allLiveUpstreams(read),
		browsableCaches(locals, db, read),
		listUserTokens(db, user.id),
		parent()
	]);

	const { stats, statsAt } = await instanceStatsSnapshot(read, gcLastRun);

	const ids = inScope.map((c) => c.id);
	// Budget warnings only for caches whose retention this viewer can change —
	// a reader of a public cache can't act on them.
	const budgeted = inScope.filter((c) => c.retention_max_bytes && canOnCache(access, 'cr', c.name));
	// Getting started tracks the viewer's own progress, not the instance's: a
	// new member on a busy instance still needs to sign in and push themselves.
	const writable = inScope.filter((c) => canOnCache(access, 'w', c.name));

	// Recent pushes and budget usage are scoped to caches this viewer can
	// browse; an empty IN () is invalid SQL, so empty scopes skip the query.
	const [recent, budgetBytes, pushed] = await Promise.all([
		ids.length === 0
			? []
			: read
					.prepare(
						`SELECT o.store_path, o.store_path_hash, o.created_at, n.nar_size, c.name AS cache_name
						 FROM object o
						 JOIN cache c ON c.id = o.cache_id
						 JOIN nar n ON n.id = o.nar_id
						 WHERE o.cache_id IN (SELECT value FROM json_each(?))
						 ORDER BY o.created_at DESC LIMIT 6`
					)
					.bind(JSON.stringify(ids))
					.all<{
						store_path: string;
						store_path_hash: string;
						created_at: string;
						nar_size: number;
						cache_name: string;
					}>()
					.then((r) => r.results),
		// Same accounting as /caches; only caches with a budget are scanned.
		cacheSizes(
			read,
			budgeted.map((c) => c.id)
		),
		// created_by is the pushing token's subject (the user id). Bounded to
		// the viewer's writable caches so the (cache_id, …) index narrows it.
		writable.length === 0
			? false
			: read
					.prepare(
						`SELECT EXISTS (SELECT 1 FROM object
						 WHERE cache_id IN (SELECT value FROM json_each(?)) AND created_by = ?) AS pushed`
					)
					.bind(JSON.stringify(writable.map((c) => c.id)), user.id)
					.first<{ pushed: number }>()
					.then((r) => Boolean(r?.pushed))
	]);

	// --- Needs attention: each item names the fix and links straight to it. ---
	const attention: AttentionItem[] = [];

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
	if (isAdmin && stats.objects > 0) {
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
			hasCache: writable.length > 0,
			hasToken: tokens.length > 0,
			hasPush: pushed,
			firstCache: writable[0]?.name ?? null
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
