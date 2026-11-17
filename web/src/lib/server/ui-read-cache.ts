import type { D1Database } from '@cloudflare/workers-types';
import { AsyncMemo } from './cache/async-memo';
import { TtlMemo } from './cache/ttl-memo';
import { isTransientD1Error } from './cache/db';

export interface UiSnapshot<T> {
	value: T;
	at: number | null;
	stale: boolean;
	unavailable: boolean;
}
type State = {
	generation: number;
	memo: AsyncMemo<UiSnapshot<unknown>>;
	last: TtlMemo<UiSnapshot<unknown>>;
};
const states = new WeakMap<D1Database, State>();

/** Display data only, after authorization. Never cache roles, grants, tokens,
 * mutation preconditions or authenticated HTML. Values can survive transient
 * D1 failures for five minutes; fresh reads and failures have bounded TTLs. */
export async function uiRead<T>(
	db: D1Database,
	key: string,
	load: () => Promise<T>,
	fallback: T,
	freshMs = 30_000
): Promise<UiSnapshot<T>> {
	let state = states.get(db);
	if (!state) {
		state = {
			generation: 0,
			memo: new AsyncMemo(30_000, 64, 10_000),
			last: new TtlMemo(300_000, 64)
		};
		states.set(db, state);
	}
	const cache = state;
	return cache.memo.get(
		key,
		async () => {
			const generation = cache.generation;
			try {
				const result = { value: await load(), at: Date.now(), stale: false, unavailable: false };
				if (generation === cache.generation) cache.last.set(key, result);
				return result;
			} catch (error) {
				if (!isTransientD1Error(error, true)) throw error;
				const prior = cache.last.get(key);
				console.warn(
					JSON.stringify({
						event: 'nimbus.ui_read',
						kind: key.split(':')[0],
						status: prior ? 'stale' : 'unavailable'
					})
				);
				return {
					value: prior ? prior.value : fallback,
					at: prior?.at ?? null,
					stale: !!prior,
					unavailable: !prior
				};
			}
		},
		(result) => (result.stale || result.unavailable ? 2_000 : freshMs)
	) as Promise<UiSnapshot<T>>;
}

export function invalidateUiReads(db: D1Database): void {
	const state = states.get(db);
	if (!state) return;
	state.generation++;
	state.memo.clear();
	state.last.clear();
}
