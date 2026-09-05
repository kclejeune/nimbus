import { afterEach, expect, it, vi } from 'vitest';
import { checkRateLimit } from './rate-limit';

afterEach(() => vi.restoreAllMocks());

it('uses Cloudflare IP, ignoring caller-supplied forwarding headers and paths', async () => {
	const limit = vi.fn().mockResolvedValue({ success: true });
	for (const path of ['sign-in/social', 'get-session']) {
		const request = new Request(`https://example.com/api/auth/${path}`, {
			headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2' }
		});
		expect(await checkRateLimit(request, { limit })).toBeNull();
	}
	for (const [options] of limit.mock.calls) expect(options).toEqual({ key: '192.0.2.1' });
});

it('supports an aggregate bucket and returns retryable, uncached refusals', async () => {
	const limit = vi.fn().mockResolvedValue({ success: false });
	const response = await checkRateLimit(
		new Request('https://example.com'),
		{ limit },
		'device-start'
	);
	expect(limit).toHaveBeenCalledWith({ key: 'device-start' });
	expect(response?.status).toBe(429);
	expect(response?.headers.get('Retry-After')).toBe('60');
	expect(response?.headers.get('Cache-Control')).toBe('no-store');
});

it('fails closed on binding failure, but supports unbound local development', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const request = new Request('https://example.com');
	expect(
		(await checkRateLimit(request, { limit: vi.fn().mockRejectedValue(new Error('unavailable')) }))
			?.status
	).toBe(503);
	expect(await checkRateLimit(request, undefined)).toBeNull();
});
