import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAfterUpload, narinfoTag, ROOT_UPSTREAM_TAG_NS } from './store';
import { candidateTag } from './metadata';
import { isKnownAbsent, recordAbsent } from './proxy';
import type { ExecutionContext } from './platform';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it.each([false, true])(
	'invalidates published paths without fetching again (purge failure: %s)',
	async (fails) => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn();
		const purgeTags = vi.fn(async () => {
			if (fails) throw new Error('purge failed');
		});
		const ctx = { exports: { CachedStore: { fetch, purgeTags } } } as unknown as ExecutionContext;
		const path = 'a'.repeat(32);
		const nar = `sha256:${'b'.repeat(64)}`;
		recordAbsent(path);
		const pending = invalidateAfterUpload(ctx, { name: 'test' }, path, nar);
		expect(isKnownAbsent(path)).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		expect(purgeTags).toHaveBeenCalledExactlyOnceWith([
			narinfoTag('test', path),
			narinfoTag(ROOT_UPSTREAM_TAG_NS, path),
			candidateTag('path', path),
			candidateTag('nar', nar)
		]);
		expect(fetch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(fails ? 1 : 0);
	}
);
