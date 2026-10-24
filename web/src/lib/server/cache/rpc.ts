/** Object-valued RPC results own a disposer even when they contain only data.
 * Read/copy the needed fields while the result is alive, then release it in
 * the calling request. Plain in-process implementations have no disposer.
 */
export function readRpcResult<T, R>(result: T, read: (value: T) => R): R {
	try {
		return read(result);
	} finally {
		(result as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose]?.();
	}
}
