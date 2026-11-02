// A settled outcome that can be handed between requests as a value.
export type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };

export const settled = <T>(work: Promise<T>): Promise<Result<T>> =>
	work.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error })
	);

export const valueOf = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
