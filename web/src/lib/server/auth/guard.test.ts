import { describe, expect, it } from 'vitest';
import { isActiveUser } from './guard';

describe('isActiveUser', () => {
	it('admins bypass status; members need active', () => {
		expect(isActiveUser({ role: 'admin', status: 'pending' })).toBe(true);
		expect(isActiveUser({ role: 'member', status: 'active' })).toBe(true);
		expect(isActiveUser({ role: 'member', status: 'pending' })).toBe(false);
	});
});
