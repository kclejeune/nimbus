import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect';

const origin = 'https://app.cache.test';

describe('safeRedirectPath', () => {
	it.each(['/caches/example', '/caches/example?tab=settings&x=1', '/tokens#new', '/'])(
		'keeps same-origin path %s',
		(path) => expect(safeRedirectPath(path, origin)).toBe(path)
	);

	it.each([
		null,
		'',
		'//example.net',
		'//example.net/path',
		'https://example.net',
		'javascript:alert(1)',
		'caches/example',
		'/\\example.net',
		'\\\\example.net',
		'/%2F%2Fexample.net',
		'/%2fexample.net/..%2f',
		'/%5Cexample.net',
		'/caches\nLocation: https://example.net',
		'/caches%0d%0aSet-Cookie:x',
		'/%E0%A4%A',
		'/a/..//example.net',
		'/a/../..//example.net/path',
		'/a/%2e%2e//example.net',
		'/a/.%2E//example.net',
		'/a/%2E%2E/%2F/example.net',
		'/./..//example.net',
		`/${'a'.repeat(3000)}`
	])('falls back to / for %j', (raw) => expect(safeRedirectPath(raw, origin)).toBe('/'));
});
