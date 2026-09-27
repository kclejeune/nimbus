import { expect, it, vi } from 'vitest';
import { routeTemplate } from './latency';
import { withRequestSpan } from './tracing';

it('normalizes the invocation root before entering a child span', async () => {
	const root = { setAttribute: vi.fn() };
	const child = { setAttribute: vi.fn() };
	const enterSpan = vi.fn(async (name: string, fn: (span: typeof child) => Promise<number>) => {
		expect(root.setAttribute).toHaveBeenCalledWith('http.route', '/_proxy/:cache/:hash.narinfo');
		return fn(child);
	});
	const ctx = { tracing: { getActiveSpan: () => root, enterSpan } };
	expect(
		await withRequestSpan(
			ctx,
			routeTemplate(new Request('https://cache.test/_proxy/test/abc.narinfo')),
			'store',
			async () => 42
		)
	).toBe(42);
	expect(enterSpan.mock.calls[0][0]).toBe('store GET /_proxy/:cache/:hash.narinfo');
	expect(child.setAttribute).toHaveBeenCalledWith('nimbus.layer', 'store');
});

it('serves with tracing disabled or without the new root span API', async () => {
	const fn = vi.fn(async () => 42);
	const request = routeTemplate(new Request('https://cache.test/nar/abc.nar.zst'));
	await withRequestSpan({}, request, 'gateway', fn);
	await withRequestSpan(
		{
			tracing: {
				enterSpan: (_name: string, run: (span: unknown) => Promise<number>) =>
					run({ setAttribute() {} })
			}
		},
		request,
		'gateway',
		fn
	);
	expect(fn).toHaveBeenCalledTimes(2);
});
