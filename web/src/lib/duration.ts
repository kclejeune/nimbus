// Human duration syntax for TTL fields: "3600s", "90m", "720h", "30d", "2w",
// "1y", or a bare number (hours, for continuity with the old hours-only
// field). Values are stored as seconds; formatDuration renders them back as
// the largest unit that divides evenly, so what the user typed round-trips
// ("720h" comes back as "30d" — same duration, canonical spelling).
// Lives outside $lib/server so Svelte components can render durations too.

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
	w: 604800,
	y: 31536000
};

/** Largest-first for canonical formatting. */
const FORMAT_ORDER = ['y', 'w', 'd', 'h', 'm', 's'] as const;

/**
 * Parse a duration into whole seconds. Returns null for anything invalid.
 * A bare number means hours (the field's historical unit).
 */
export function parseDuration(raw: string): number | null {
	const match = /^(\d+(?:\.\d+)?)\s*([smhdwy]?)$/.exec(raw.trim().toLowerCase());
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const seconds = amount * UNIT_SECONDS[match[2] || 'h'];
	return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

/** Canonical rendering: the largest unit that divides the value evenly. */
export function formatDuration(seconds: number): string {
	for (const unit of FORMAT_ORDER) {
		const size = UNIT_SECONDS[unit];
		if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
	}
	return `${seconds}s`;
}
