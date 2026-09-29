import { describe, expect, it } from 'vitest';
import { explainRetention, retentionCutoff, type RetentionFacts } from './retention-explain';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();

function facts(over: Partial<RetentionFacts> = {}): RetentionFacts {
	return {
		now: NOW,
		detachedAt: null,
		createdAt: daysAgo(40),
		lastAccessedAt: null,
		pinnedAs: { named: [], quick: false },
		protectedBy: [],
		referrers: 0,
		freshAncestor: null,
		liveAncestor: null,
		retentionDays: null,
		retentionMaxBytes: null,
		globalMaxBytes: null,
		...over
	};
}

describe('explainRetention', () => {
	it('pins beat every other rule', () => {
		const r = explainRetention(
			facts({ pinnedAs: { named: ['release-0.8'], quick: false }, retentionDays: 1 })
		);
		expect(r.status.label).toBe('Protected');
		expect(r.reasons).toHaveLength(1);
		expect(r.reasons[0].title).toBe('Pinned as release-0.8');
	});

	it('names the pins whose closure holds the path', () => {
		const r = explainRetention(
			facts({ protectedBy: [{ label: 'atlas' }, { label: 'hm-kennan' }] })
		);
		expect(r.status.tone).toBe('success');
		expect(r.reasons[0].title).toBe('Protected by atlas, hm-kennan');
	});

	it('uses last pull, falling back to push time, against the window', () => {
		const fresh = explainRetention(
			facts({ retentionDays: 30, lastAccessedAt: daysAgo(3), createdAt: daysAgo(90) })
		);
		expect(fresh.status.label).toBe('Kept');
		expect(fresh.reasons[0].detail).toContain('Last pulled 3 days ago');
		expect(fresh.reasons[0].detail).toContain('2026-10-26');

		const pushedOnly = explainRetention(facts({ retentionDays: 30, createdAt: daysAgo(2) }));
		expect(pushedOnly.reasons[0].detail).toContain('Last pushed 2 days ago');
	});

	it('keeps a stale path a fresh dependent still reaches', () => {
		const kept = explainRetention(
			facts({ retentionDays: 30, lastAccessedAt: daysAgo(45), freshAncestor: true, referrers: 2 })
		);
		expect(kept.status.label).toBe('Kept');
		expect(kept.reasons[0].title).toContain('but still needed');

		const doomed = explainRetention(
			facts({ retentionDays: 30, lastAccessedAt: daysAgo(45), freshAncestor: false })
		);
		expect(doomed.status.label).toBe('Due for removal');
	});

	it('applies the same slack as the GC cutoff', () => {
		// Just past 30 days, but inside the 2 h touch slack: still fresh.
		const edge = new Date(retentionCutoff(NOW, 30) + 60_000).toISOString();
		const r = explainRetention(facts({ retentionDays: 30, lastAccessedAt: edge }));
		expect(r.reasons[0].title).toMatch(/^Expires/);
	});

	it('explains detached paths by whether anything live still needs them', () => {
		const held = explainRetention(
			facts({ detachedAt: daysAgo(1), liveAncestor: true, referrers: 1 })
		);
		expect(held.status.label).toBe('Being removed');
		expect(held.reasons[0].detail).toContain('a path that depends on it is still here');

		const gone = explainRetention(facts({ detachedAt: daysAgo(1), liveAncestor: false }));
		expect(gone.reasons[0].detail).toContain('next GC deletes it');

		const pinned = explainRetention(
			facts({ detachedAt: daysAgo(1), protectedBy: [{ label: 'atlas' }] })
		);
		expect(pinned.status.label).toBe('Protected');
	});

	it('describes size eviction by whether the path is top-level', () => {
		const top = explainRetention(facts({ retentionMaxBytes: 10 * 1024 ** 3 }));
		expect(top.reasons.map((r) => r.title)).toEqual([
			'No age limit',
			'If the cache exceeds its 10 GiB limit'
		]);
		expect(top.reasons[1].detail).toContain('Nothing depends on this path');

		const dep = explainRetention(facts({ globalMaxBytes: 250 * 1024 ** 3, referrers: 3 }));
		expect(dep.reasons[1].title).toBe('If the instance exceeds its 250 GiB storage limit');
		expect(dep.reasons[1].detail).toContain('3 paths depend on this one');
	});
});

describe('explainRetention labels', () => {
	it('lists each protecting pin once', () => {
		const r = explainRetention(
			facts({ protectedBy: [{ label: 'atlas' }, { label: 'atlas' }, { label: 'hm-kennan' }] })
		);
		expect(r.reasons[0].title).toBe('Protected by atlas, hm-kennan');
	});

	it('does not call a removed pinned path removal-blocked', () => {
		const r = explainRetention(
			facts({ detachedAt: daysAgo(1), pinnedAs: { named: ['acme'], quick: false } })
		);
		expect(r.reasons[0].detail).not.toContain('blocked');
	});
});
