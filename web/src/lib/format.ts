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

/** GiB value for a size-limit input from stored bytes; '' when unset. */
export function gibInputValue(bytes: number | null | undefined): string {
	return bytes != null ? (bytes / 2 ** 30).toFixed(1).replace(/\.0$/, '') : '';
}

/**
 * Bytes from a GiB size-limit form field: '' means no limit (null), anything
 * that isn't a positive number is invalid (undefined, caller rejects).
 */
export function gibFieldToBytes(raw: FormDataEntryValue | null): number | null | undefined {
	const trimmed = String(raw ?? '').trim();
	if (trimmed === '') return null;
	const gib = Number(trimmed);
	if (!Number.isFinite(gib) || gib <= 0) return undefined;
	return Math.round(gib * 2 ** 30);
}

/** "YYYY-MM-DD HH:MM" (UTC) from an ISO string; em dash when absent. */
export function formatIsoDateTime(iso: string | null | undefined): string {
	return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

/** "YYYY-MM-DD" (UTC) from an ISO string; em dash when absent. */
export function formatIsoDate(iso: string | null | undefined): string {
	return iso ? iso.slice(0, 10) : '—';
}

/** /nix/store/ prefix trimmed, keeping <hash>-<name>. */
export function shortStorePath(path: string): string {
	return path.replace(/^\/nix\/store\//, '');
}

/** /nix/store/<hash>-<name> split into its parts; `hash` is '' (and `name`
 *  the whole trimmed path) when the path doesn't have that shape. */
export function splitStorePath(path: string): { hash: string; name: string } {
	const base = shortStorePath(path);
	const m = /^([0-9a-z]{32})-(.+)$/.exec(base);
	return m ? { hash: m[1], name: m[2] } : { hash: '', name: base };
}

/** Dedup savings and limit usage from instance stats (Overview tiles and the
 *  Usage storage view): bytes the store would hold without NAR- and
 *  chunk-level dedup, minus what it actually holds. */
export function storageSavings(
	stats: { logicalBytes: number; storageBytes: number },
	globalMaxBytes: number | null
): { dedupBytes: number; dedupPct: number; usagePct: number | null } {
	const dedupBytes = Math.max(0, stats.logicalBytes - stats.storageBytes);
	return {
		dedupBytes,
		dedupPct: stats.logicalBytes > 0 ? Math.round((dedupBytes / stats.logicalBytes) * 100) : 0,
		usagePct: globalMaxBytes ? Math.round((stats.storageBytes / globalMaxBytes) * 100) : null
	};
}

/** "1 path", "3 paths". */
export function plural(n: number, one: string, many = one + 's'): string {
	return `${n} ${n === 1 ? one : many}`;
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

/** Latency: sub-10 ms keeps a decimal, seconds past 1,000 ms. */
export function formatMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
	if (ms < 10) return `${ms.toFixed(1)} ms`;
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Compact count: 950, 12.9K, 4.2M. */
export function formatCompact(n: number): string {
	if (!Number.isFinite(n)) return '0';
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	const [div, unit] = abs < 1e6 ? [1e3, 'K'] : abs < 1e9 ? [1e6, 'M'] : [1e9, 'B'];
	const v = n / div;
	return `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)}${unit}`;
}

/** A rate per second, scaled to /min or /h when it's too small to read. */
export function formatRate(perSecond: number): string {
	if (!Number.isFinite(perSecond) || perSecond <= 0) return '0/s';
	if (perSecond >= 1)
		return `${perSecond < 100 ? perSecond.toFixed(1) : formatCompact(perSecond)}/s`;
	if (perSecond * 60 >= 1) return `${(perSecond * 60).toFixed(1)}/min`;
	return `${(perSecond * 3600).toFixed(1)}/h`;
}

/** A 0–1 fraction as a percentage; small nonzero shares keep precision. */
export function formatPct(fraction: number | null | undefined, digits?: number): string {
	if (fraction == null || !Number.isFinite(fraction)) return '—';
	const p = fraction * 100;
	const d = digits ?? (p !== 0 && Math.abs(p) < 1 ? 2 : p < 10 ? 1 : 0);
	return `${p.toFixed(d)}%`;
}
