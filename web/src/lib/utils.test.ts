import { describe, expect, it } from 'vitest';
import { serverAlias } from './utils';

describe('serverAlias', () => {
	it('takes the first non-generic host label', () => {
		expect(serverAlias('https://cache.kclj.io')).toBe('kclj');
		expect(serverAlias('https://nix.cache.example.com')).toBe('example');
		expect(serverAlias('http://localhost:8788')).toBe('localhost');
	});
	it('falls back to nimbus when there is nothing better', () => {
		expect(serverAlias('not a url')).toBe('nimbus');
		expect(serverAlias('https://cache.nix')).toBe('nimbus');
	});
});
