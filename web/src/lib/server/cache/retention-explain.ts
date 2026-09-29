// Plain-language "why is this path kept?" for the store path page. Pure:
// the page's loader gathers the facts; this turns them into reasons that
// mirror what gc.ts actually does (see the rule notes on each branch).
import { TOUCH_GRANULARITY_MS } from './db';
import { plural } from '$lib/format';

const DAY_MS = 86400_000;

export interface RetentionFacts {
	now: number;
	/** ISO; detached (removed) objects never seed GC's keep set. */
	detachedAt: string | null;
	createdAt: string;
	/** ISO of the last pull (download touch), or null if never pulled. */
	lastAccessedAt: string | null;
	/** gc_root rows on this very path: named pin revisions and/or a quick pin. */
	pinnedAs: { named: string[]; quick: boolean };
	/** Other pinned paths whose closure contains this one. */
	protectedBy: { label: string }[];
	/** Paths in this cache referencing this one, detached or not. */
	referrers: number;
	/**
	 * Whether some other live path that (transitively) depends on this one is
	 * itself fresh (retention) or live (detached). null when not computed
	 * because a cheaper fact already settles the answer.
	 */
	freshAncestor: boolean | null;
	liveAncestor: boolean | null;
	retentionDays: number | null;
	retentionMaxBytes: number | null;
	globalMaxBytes: number | null;
}

export type ReasonTone = 'protected' | 'info' | 'warning';

export interface RetentionReason {
	tone: ReasonTone;
	title: string;
	detail: string;
}

export interface RetentionExplanation {
	/** One-line verdict for the panel header. */
	status: { tone: 'success' | 'neutral' | 'warning'; label: string };
	reasons: RetentionReason[];
}

function listNames(names: string[], max = 3): string {
	const shown = names.slice(0, max);
	const rest = names.length - shown.length;
	return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** The retention cutoff for a window of `days` — gc.ts's retention pass and
 *  this page's explanation both use it, so they can't disagree. */
export function retentionCutoff(now: number, days: number): number {
	// The window plus slack for a cached touch decision and the gateway memo
	// window.
	return now - days * DAY_MS - 2 * TOUCH_GRANULARITY_MS;
}

export function explainRetention(f: RetentionFacts): RetentionExplanation {
	const reasons: RetentionReason[] = [];
	const pinnedHere = f.pinnedAs.named.length > 0 || f.pinnedAs.quick;
	const isProtected = pinnedHere || f.protectedBy.length > 0;

	// gc_root closures are exempt from every pass: the retention window
	// (UNREACHABLE_SQL keep seeds), cache and global size eviction (the
	// `protected` CTEs), and detached reaping (REAP_DETACHED_SQL keep seeds).
	if (pinnedHere) {
		const names = f.pinnedAs.named;
		reasons.push({
			tone: 'protected',
			title:
				names.length > 0
					? `Pinned as ${listNames(names)}${f.pinnedAs.quick ? ', and pinned directly' : ''}`
					: 'Pinned',
			detail: `GC never removes a pinned path or its dependencies.${f.detachedAt ? '' : ' Removal is blocked until it’s unpinned.'}`
		});
	} else if (f.protectedBy.length > 0) {
		reasons.push({
			tone: 'protected',
			title: `Protected by ${listNames([...new Set(f.protectedBy.map((p) => p.label))])}`,
			detail: 'A pinned path depends on it. GC keeps it while that pin exists.'
		});
	}

	if (f.detachedAt) {
		// Detached objects never seed the keep set; they survive only while a
		// live object or a gc_root closure still reaches them.
		if (isProtected) {
			reasons.push({
				tone: 'info',
				title: 'Removed from this cache',
				detail: 'Kept because a pin still depends on it.'
			});
		} else if (f.liveAncestor) {
			reasons.push({
				tone: 'warning',
				title: 'Removed from this cache',
				detail: `Still served because ${f.referrers === 1 ? 'a path that depends on it is' : 'paths that depend on it are'} still here. GC deletes it once none are.`
			});
		} else {
			reasons.push({
				tone: 'warning',
				title: 'Removed from this cache',
				detail: 'Nothing here depends on it, so the next GC deletes it.'
			});
		}
		return {
			status: isProtected
				? { tone: 'success', label: 'Protected' }
				: { tone: 'warning', label: 'Being removed' },
			reasons
		};
	}

	if (isProtected) {
		return { status: { tone: 'success', label: 'Protected' }, reasons };
	}

	let atRisk = false;

	// Retention window: fresh = COALESCE(last_accessed_at, created_at) at or
	// after the cutoff; an object survives while reachable from any fresh,
	// live object (itself included).
	if (f.retentionDays != null) {
		const lastUsedIso = f.lastAccessedAt ?? f.createdAt;
		const lastUsed = Date.parse(lastUsedIso);
		const cutoff = retentionCutoff(f.now, f.retentionDays);
		const verb = f.lastAccessedAt ? 'pulled' : 'pushed';
		if (lastUsed >= cutoff) {
			const eligible = new Date(lastUsed + f.retentionDays * DAY_MS);
			reasons.push({
				tone: 'info',
				title: `Expires ${plural(f.retentionDays, 'day')} after its last use`,
				detail: `Last ${verb} ${formatAgo(f.now - lastUsed)}. Eligible for removal after ${eligible.toISOString().slice(0, 10)} unless it or a dependent is pulled again.`
			});
		} else if (f.freshAncestor) {
			reasons.push({
				tone: 'info',
				title: `Past its ${f.retentionDays}-day window, but still needed`,
				detail: `Last ${verb} ${formatAgo(f.now - lastUsed)}. A dependent was used recently, so it stays as long as that path does.`
			});
		} else {
			atRisk = true;
			reasons.push({
				tone: 'warning',
				title: `Past its ${f.retentionDays}-day window`,
				detail: `Last ${verb} ${formatAgo(f.now - lastUsed)}. No dependent has been used since, so the next GC removes it.`
			});
		}
	} else {
		reasons.push({
			tone: 'info',
			title: 'No age limit',
			detail:
				f.retentionMaxBytes == null && f.globalMaxBytes == null
					? 'This cache keeps paths until they’re removed.'
					: 'This cache keeps paths until they’re removed or a size limit evicts them.'
		});
	}

	// Size eviction (cache budget, then the instance-wide limit) picks the
	// least recently used top-level path — one nothing else references — and
	// deletes it with whatever only it depends on.
	const sizeDetail =
		f.referrers > 0
			? `Least recently used top-level paths go first, with their unshared dependencies. ${plural(f.referrers, 'path')} ${f.referrers === 1 ? 'depends' : 'depend'} on this one, so it goes with the last of them.`
			: 'Least recently used top-level paths go first, with their unshared dependencies. Nothing depends on this path, so its own last use decides.';
	if (f.retentionMaxBytes != null) {
		reasons.push({
			tone: 'info',
			title: `If the cache exceeds its ${formatGiB(f.retentionMaxBytes)} limit`,
			detail: sizeDetail
		});
	}
	if (f.globalMaxBytes != null) {
		reasons.push({
			tone: 'info',
			title: `If the instance exceeds its ${formatGiB(f.globalMaxBytes)} storage limit`,
			detail: sizeDetail
		});
	}

	return {
		status: atRisk
			? { tone: 'warning', label: 'Due for removal' }
			: { tone: 'neutral', label: 'Kept' },
		reasons
	};
}

function formatAgo(ms: number): string {
	const days = Math.floor(ms / DAY_MS);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	return `${days} days ago`;
}

function formatGiB(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	return `${gib >= 10 ? Math.round(gib) : Number(gib.toFixed(1))} GiB`;
}
