import { expect, it } from 'vitest';
import { formatCompact, formatMs, formatPct, formatRate } from './format';

it('formats latency, counts, rates and shares for the usage views', () => {
	expect(formatMs(0)).toBe('0 ms');
	expect(formatMs(7.84)).toBe('7.8 ms');
	expect(formatMs(196.4)).toBe('196 ms');
	expect(formatMs(2900)).toBe('2.90 s');
	expect(formatCompact(950)).toBe('950');
	expect(formatCompact(12_940)).toBe('12.9K');
	expect(formatCompact(4_200_000)).toBe('4.2M');
	expect(formatRate(18.23)).toBe('18.2/s');
	expect(formatRate(0.05)).toBe('3.0/min');
	expect(formatRate(0.0005)).toBe('1.8/h');
	expect(formatPct(0.0042)).toBe('0.42%');
	expect(formatPct(0.071)).toBe('7.1%');
	expect(formatPct(0.66)).toBe('66%');
	expect(formatPct(null)).toBe('—');
});
