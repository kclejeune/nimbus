import { describe, expect, it, vi } from 'vitest';
import { takeBudget, requireBudget, AdmissionError } from './admission';
import {
	fetchUpstreamNarInfo,
	filterUpstreamPaths,
	PROBE_REFUSED,
	recordVerdicts,
	VERDICT_PRESENT,
	type Upstream
} from './missing-paths';
import { testDatabase } from './test-db';

describe('work admission', () => {
	it('fails closed on limiter failure and gives a retryable no-store response', async () => {
		const limiter = {
			limit: async () => {
				throw new Error('binding failed');
			}
		};
		expect(await takeBudget(limiter, 'work')).toBe(false);
		await expect(requireBudget(limiter, 'work')).rejects.toBeInstanceOf(AdmissionError);
		const response = new AdmissionError('busy').response();
		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('retry-after')).toBe('60');
	});
	it('charges every upstream fetch and degrades batch probes instead of failing them', async () => {
		const fixture = testDatabase();
		const fetch = vi.fn(async () => new Response(null, { status: 404 }));
		vi.stubGlobal('fetch', fetch);
		const upstreams: Upstream[] = [1, 2].map((id) => ({
			id,
			url: `https://up${id}.test`,
			publicKey: null,
			ttl: null,
			mode: 'redirect',
			persistInto: null,
			nixDefault: false
		}));
		let calls = 0;
		const env = {
			UPSTREAM_PROBE_LIMITER: { limit: async () => ({ success: ++calls <= 1 }) },
			VERDICT_WRITE_LIMITER: { limit: async () => ({ success: false }) }
		} as unknown as App.Platform['env'];
		try {
			expect(
				await fetchUpstreamNarInfo(fixture.db, upstreams, 'a'.repeat(32), undefined, {
					env,
					ip: 'test'
				})
			).toBe(PROBE_REFUSED);
			expect(calls).toBe(2);
			expect(fetch).toHaveBeenCalledOnce();
			const before = fixture.totalChanges();
			await recordVerdicts(
				fixture.db,
				1,
				[{ hash: 'b'.repeat(32), verdict: VERDICT_PRESENT }],
				env
			);
			expect(fixture.totalChanges()).toBe(before);
			// Budget already spent: the unprobed path is reported missing, no throw.
			expect(
				await filterUpstreamPaths(fixture.db, upstreams, ['c'.repeat(32)], { env, ip: 'test' })
			).toEqual(['c'.repeat(32)]);
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			fixture.sqlite.close();
			vi.unstubAllGlobals();
		}
	});
});
