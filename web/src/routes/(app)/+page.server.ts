import { error } from '@sveltejs/kit';
import { cacheSizes, readGcLastRun, readGlobalMaxBytes } from '$lib/server/cache/gc';
import { allLiveUpstreams } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { readSession } from '$lib/server/cache/db';
import { AsyncMemo } from '$lib/server/cache/async-memo';
import { newestAcrossCaches, toCrossCachePath } from '$lib/server/store-paths';
import { instanceStatsSnapshot } from '$lib/server/cache/stats';
import { canOnCache } from '$lib/server/auth/permissions';
import { browsableCaches } from '$lib/server/cache/cache-page';
import { listUserTokens } from '$lib/server/tokens';
import { BUDGET_WARN, plural, storageSavings } from '$lib/format';
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

/** Whether each user has pushed anything (see the onboarding query below). */
const hasPushed = new AsyncMemo<boolean>(60_000, 1_000);

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
		listUserTokens(read, user.id),
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
	// browse.
	const [recent, budgetBytes, pushed] = await Promise.all([
		newestAcrossCaches(read, ids, 6),
		// Same accounting (and memo) as /caches; skipped with no budget to check.
		budgeted.length === 0 ? new Map<number, number>() : cacheSizes(read),
		// created_by is the pushing token's subject (the user id). Unindexed,
		// so a viewer who never pushed scans every object in their writable
		// caches — skipped when they hold no token, since then the push step
		// can't be next anyway, and remembered: a yes for a day (it doesn't
		// go back), a no for a minute. (An index would bill a row per pushed
		// path to save this; not worth it.)
		writable.length === 0 || tokens.length === 0
			? false
			: hasPushed.get(
					user.id,
					() =>
						read
							.prepare(
								`SELECT EXISTS (SELECT 1 FROM object
								 WHERE cache_id IN (SELECT value FROM json_each(?)) AND created_by = ?) AS pushed`
							)
							.bind(JSON.stringify(writable.map((c) => c.id)), user.id)
							.first<{ pushed: number }>()
							.then((r) => Boolean(r?.pushed)),
					(pushed) => (pushed ? 86_400_000 : 60_000)
				)
	]);

	// --- Needs attention: each item names the fix and links straight to it. ---
	const attention: AttentionItem[] = [];

	if (isAdmin && pendingUsers > 0) {
		attention.push({
			tone: 'warning',
			title: `${plural(pendingUsers, 'person is', 'people are')} waiting for access`,
			detail: 'They can’t use nimbus until an admin activates them.',
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
				'Their references aren’t in any cache or upstream, so Nix may fail to substitute them.',
			href: '/settings',
			action: 'See affected paths'
		});
	}
	if (isAdmin && stats.objects > 0) {
		const last = gcLastRun ? Date.parse(gcLastRun.at) : NaN;
		if (!gcLastRun || Date.now() - last > GC_OVERDUE_MS) {
			attention.push({
				tone: 'warning',
				title: gcLastRun ? 'Nightly GC is overdue' : 'GC hasn’t run yet',
				detail: gcLastRun
					? 'Expired paths and unused storage aren’t being reclaimed.'
					: 'It runs nightly. Run it now to get storage totals sooner.',
				href: '/settings',
				action: 'Open settings'
			});
		}
	}
	if (isAdmin && globalMaxBytes && stats.storageBytes >= globalMaxBytes * BUDGET_WARN) {
		attention.push({
			tone: stats.storageBytes >= globalMaxBytes ? 'danger' : 'warning',
			title: `Storage is at ${storageSavings(stats, globalMaxBytes).usagePct}% of the instance limit`,
			detail: 'Over the limit, the least recently used closures are evicted from every cache.',
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
			detail: 'Over budget, its least recently used closures are evicted.',
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
			detail:
				expiring.length === 1
					? 'Create a replacement before it expires.'
					: 'Create replacements before they expire.',
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
		recent: recent.map(toCrossCachePath),
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
