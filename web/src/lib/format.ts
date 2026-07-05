/** Human-readable byte size (binary units). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / Math.pow(1024, i);
	return `${value.toFixed(i === 0 ? 0 : value < 10 ? 2 : 1)} ${units[i]}`;
}

/** Thousands-separated integer. */
export function formatCount(n: number): string {
	return new Intl.NumberFormat('en-US').format(n);
}
