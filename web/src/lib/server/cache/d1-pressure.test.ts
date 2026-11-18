import { afterEach, expect, it, vi } from 'vitest';
import { d1OverloadDelay, isD1Overload, noteD1Overload } from './d1-pressure';
import { isTransientD1Error } from './db';
import { isGcResourceError } from './gc-pacing';
afterEach(() => vi.useRealTimers());
const account =
	'D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.';
it.each([
	account,
	'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.',
	'D1_ERROR: Requests queued for too long.'
])('recognizes pressure consistently across read recovery and GC: %s', (message) => {
	const error = new Error(message);
	expect(isD1Overload(error)).toBe(true);
	expect(isTransientD1Error(error)).toBe(true);
	expect(isGcResourceError(error)).toBe(true);
});
it.each([
	'no such table: object',
	'D1_ERROR: Account storage limit exceeded',
	'D1_ERROR: UNIQUE constraint failed'
])('does not retry permanent failures as pressure: %s', (message) => {
	expect(isD1Overload(new Error(message))).toBe(false);
	expect(isGcResourceError(new Error(message))).toBe(false);
});
it('account throttling starts and extends the same bounded cooldown', () => {
	vi.useFakeTimers();
	noteD1Overload(new Error(account));
	expect(d1OverloadDelay()).toBe(2000);
	vi.advanceTimersByTime(1500);
	noteD1Overload(new Error(account));
	expect(d1OverloadDelay()).toBe(2000);
	vi.advanceTimersByTime(2000);
	expect(d1OverloadDelay()).toBe(0);
});
