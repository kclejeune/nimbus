import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	takeBudget,
	requireBudget,
	requireStorageBudget,
	requireBackendReadBudget,
	AdmissionError
} from './admission';
import type { LimitOutcome } from '../rate-limit';
import {
	fetchUpstreamNarInfo,
	filterUpstreamPaths,
	PROBE_REFUSED,
	recordVerdicts,
	VERDICT_PRESENT,
	type Upstream
} from './missing-paths';
import { testDatabase } from './test-db';

describe('storage budget telemetry', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each<{
		outcome: LimitOutcome;
		units: LimitOutcome[];
		rejectedUnits: number;
		errorUnits: number;
	}>([
		{ outcome: 'allowed', units: ['allowed', 'allowed'], rejectedUnits: 0, errorUnits: 0 },
		{ outcome: 'rejected', units: ['allowed', 'rejected'], rejectedUnits: 1, errorUnits: 0 },
		{ outcome: 'error', units: ['allowed', 'error'], rejectedUnits: 0, errorUnits: 1 },
		{ outcome: 'error', units: ['rejected', 'error'], rejectedUnits: 1, errorUnits: 1 }
	])('records $units and fails closed unless all units allow', async (test) => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const limit = vi.fn();
		for (const outcome of test.units) {
			if (outcome === 'error') limit.mockRejectedValueOnce(new Error('binding unavailable'));
			else limit.mockResolvedValueOnce({ success: outcome === 'allowed' });
		}
		const bytes = 1024 * 1024 + 1;
		const attempt = requireStorageBudget({ limit }, bytes);
		if (test.outcome === 'allowed') await expect(attempt).resolves.toBeUndefined();
		else await expect(attempt).rejects.toBeInstanceOf(AdmissionError);
		expect(limit).toHaveBeenCalledTimes(2);
		for (const args of limit.mock.calls) expect(args).toEqual([{ key: 'storage-write' }]);
		expect(log).toHaveBeenCalledOnce();
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({
			event: 'nimbus.storage_budget',
			outcome: test.outcome,
			bytes,
			units: 2,
			allowedUnits: 2 - test.rejectedUnits - test.errorUnits,
			rejectedUnits: test.rejectedUnits,
			errorUnits: test.errorUnits
		});
	});

	it('skips unbound and empty reservations', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const limit = vi.fn();
		await requireStorageBudget(undefined, 1024);
		await requireStorageBudget({ limit }, 0);
		expect(limit).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});
});

describe('work admission', () => {
	it('charges cold reads to both per-client and aggregate budgets', async () => {
		const client = { limit: vi.fn(async () => ({ success: true })) };
		const aggregate = { limit: vi.fn(async () => ({ success: true })) };
		await requireBackendReadBudget(
			{
				BACKEND_READ_LIMITER: client,
				BACKEND_READ_GLOBAL_LIMITER: aggregate
			} as unknown as App.Platform['env'],
			'203.0.113.9'
		);
		expect(client.limit).toHaveBeenCalledWith({ key: 'backend-read:203.0.113.9' });
		expect(aggregate.limit).toHaveBeenCalledWith({ key: 'backend-read-global' });
	});

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
			).toEqual({ missing: ['c'.repeat(32)], deferred: ['c'.repeat(32)] });
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			fixture.sqlite.close();
			vi.unstubAllGlobals();
		}
	});
});
