import { describe, expect, it } from 'vitest';
import { validateUpstreamUrl } from './upstream-registry';

describe('validateUpstreamUrl', () => {
	it('normalizes public HTTPS cache roots', () => {
		expect(validateUpstreamUrl('https://cache.example.org/nix/')).toEqual({
			url: 'https://cache.example.org/nix'
		});
	});

	it.each([
		'http://cache.example.org',
		'https://user:secret@cache.example.org',
		'https://cache.example.org:8443',
		'https://cache.example.org/?token=secret',
		'https://localhost',
		'https://localhost.',
		'https://localhost..',
		'https://service.local.',
		'https://service.internal.',
		'https://127.0.0.1',
		'https://127.0.0.1.',
		'https://10.2.3.4',
		'https://169.254.169.254',
		'https://[::1]'
	])('rejects unsafe fetch destination %s', (url) => {
		expect(validateUpstreamUrl(url)).toHaveProperty('error');
	});
});
