import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from './duration';

describe('parseDuration', () => {
	it('parses every unit', () => {
		expect(parseDuration('3600s')).toBe(3600);
		expect(parseDuration('90m')).toBe(5400);
		expect(parseDuration('720h')).toBe(2592000);
		expect(parseDuration('30d')).toBe(2592000);
		expect(parseDuration('2w')).toBe(1209600);
		expect(parseDuration('1y')).toBe(31536000);
	});

	it('treats bare numbers as hours (the field is historically hours)', () => {
		expect(parseDuration('168')).toBe(604800);
		expect(parseDuration('1.5')).toBe(5400);
	});

	it('tolerates whitespace and case', () => {
		expect(parseDuration(' 30D ')).toBe(2592000);
	});

	it('rejects garbage, negatives, and zero', () => {
		expect(parseDuration('')).toBeNull();
		expect(parseDuration('soon')).toBeNull();
		expect(parseDuration('-5h')).toBeNull();
		expect(parseDuration('0d')).toBeNull();
		expect(parseDuration('5 days')).toBeNull();
	});
});

describe('formatDuration', () => {
	it('renders the largest unit that divides evenly', () => {
		expect(formatDuration(31536000)).toBe('1y');
		expect(formatDuration(2592000)).toBe('30d');
		expect(formatDuration(604800)).toBe('1w');
		expect(formatDuration(5400)).toBe('90m');
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(90)).toBe('90s');
	});

	it('round-trips parse -> format -> parse', () => {
		for (const raw of ['720h', '30d', '1y', '168h', '90m']) {
			const seconds = parseDuration(raw)!;
			expect(parseDuration(formatDuration(seconds))).toBe(seconds);
		}
	});
});
