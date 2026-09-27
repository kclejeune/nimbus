import { afterEach, expect, it, vi } from 'vitest';
import { UpstreamCooldown } from './upstream-cooldown';
afterEach(() => vi.useRealTimers());

it('opens after repeated failures, permits one recovery probe, and recovers', async () => {
	vi.useFakeTimers();
	const health = new UpstreamCooldown();
	const failed = vi.fn(async (): Promise<number | null> => null);
	for (let i = 0; i < 5; i++) expect(await health.run('u', failed, null)).toBeNull();
	expect(failed).toHaveBeenCalledTimes(3);
	vi.advanceTimersByTime(15_000);
	let resolve!: (n: number) => void;
	const recovery = health.run(
		'u',
		() =>
			new Promise<number | null>((r) => {
				resolve = r;
			}),
		null
	);
	expect(await health.run('u', failed, null)).toBeNull();
	expect(failed).toHaveBeenCalledTimes(3);
	resolve(0);
	expect(await recovery).toBe(0); // An ABSENT verdict is healthy.
	expect(await health.run('u', async (): Promise<number | null> => 1, null)).toBe(1);
});

it('does not turn a caller deadline into an upstream outage', async () => {
	const health = new UpstreamCooldown();
	for (let i = 0; i < 10; i++)
		await health.run(
			'u',
			async () => null,
			null,
			() => true
		);
	expect(await health.run('u', async (): Promise<number | null> => 1, null)).toBe(1);
});

it('bounds recovery backoff and recovers an abandoned probe', async () => {
	vi.useFakeTimers();
	const health = new UpstreamCooldown();
	for (let i = 0; i < 3; i++) await health.run('u', async () => null, null);
	vi.advanceTimersByTime(15_000);
	let resolve!: (n: number) => void;
	const abandoned = health.run(
		'u',
		() =>
			new Promise<number | null>((r) => {
				resolve = r;
			}),
		null
	);
	vi.advanceTimersByTime(6_000);
	await health.run('u', async () => null, null);
	resolve(1);
	await abandoned;
	const healthy = vi.fn(async (): Promise<number | null> => 1);
	expect(await health.run('u', healthy, null)).toBeNull();
	vi.advanceTimersByTime(30_000);
	expect(await health.run('u', healthy, null)).toBe(1);
});
