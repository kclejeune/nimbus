import { expect, it, vi } from 'vitest';
import { readRpcResult } from './rpc';

it('copies purge acknowledgement data before disposing the RPC result', () => {
	let alive = true;
	const dispose = vi.fn(() => {
		alive = false;
	});
	const result = {
		get confirmed() {
			if (!alive) throw new Error('disposed');
			return true;
		},
		[Symbol.dispose]: dispose
	};
	const copied = readRpcResult(result, ({ confirmed }) => ({ confirmed }));
	expect(copied).toEqual({ confirmed: true });
	expect(dispose).toHaveBeenCalledOnce();
	expect(() => result.confirmed).toThrow('disposed');
});

it('disposes even when reading the result throws, and accepts in-process results', () => {
	const dispose = vi.fn();
	expect(() =>
		readRpcResult({ [Symbol.dispose]: dispose }, () => {
			throw new Error('failed');
		})
	).toThrow('failed');
	expect(dispose).toHaveBeenCalledOnce();
	expect(readRpcResult({ confirmed: false }, (r) => r.confirmed)).toBe(false);
});
