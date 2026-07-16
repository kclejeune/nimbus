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

/** ISO date (YYYY-MM-DD) from unix seconds. */
export function formatDate(unix: number): string {
	return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** ISO timestamp to the minute (UTC) from unix seconds. */
export function formatDateTime(unix: number): string {
	return formatIsoDateTime(new Date(unix * 1000).toISOString());
}

/** "YYYY-MM-DD HH:MM" (UTC) from an ISO string; em dash when absent. */
export function formatIsoDateTime(iso: string | null | undefined): string {
	return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

/** Coarse relative time ("3h ago") from an ISO timestamp; '' when unparsable. */
export function formatRelativeTime(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms)) return '';
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	const d = Math.floor(s / 86400);
	return d === 1 ? 'yesterday' : `${d} days ago`;
}
