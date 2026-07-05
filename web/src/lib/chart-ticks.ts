// X-axis tick selection for date-labeled series. Snaps ticks to calendar
// boundaries (month or week starts) so a long daily/weekly axis reads as
// regular intervals instead of arbitrary evenly-spaced dates.

const DAY = 86400_000;

function dedupe(a: number[]): number[] {
	return a.filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => x - y);
}

function evenIndices(n: number, count: number): number[] {
	if (n <= 0) return [];
	if (n <= count) return [...Array(n).keys()];
	const step = (n - 1) / (count - 1);
	return dedupe(Array.from({ length: count }, (_, k) => Math.round(k * step)));
}

function parseIso(label: string): number {
	// Accept 'YYYY-MM' (month) or 'YYYY-MM-DD'.
	return Date.parse(`${label.length === 7 ? `${label}-01` : label}T00:00:00Z`);
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function firstMonthOnOrAfter(ms: number): number {
	const d = new Date(ms);
	const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
	return first >= ms ? first : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function addMonths(ms: number, k: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1);
}

function monthTicks(firstMs: number, lastMs: number, maxTicks: number): string[] {
	const a = new Date(firstMonthOnOrAfter(firstMs));
	const b = new Date(lastMs);
	const total = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
	const step = Math.max(1, Math.ceil(total / maxTicks));
	const out: string[] = [];
	for (let ms = firstMonthOnOrAfter(firstMs); ms <= lastMs; ms = addMonths(ms, step)) {
		out.push(isoDate(ms));
	}
	return out;
}

function mondayOnOrAfter(ms: number): number {
	const d = new Date(ms);
	const daysSinceMonday = (d.getUTCDay() + 6) % 7;
	const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
	return monday >= ms ? monday : monday + 7 * DAY;
}

function weekTicks(firstMs: number, lastMs: number, maxTicks: number): string[] {
	const start = mondayOnOrAfter(firstMs);
	const weeks = Math.floor((lastMs - start) / (7 * DAY)) + 1;
	const step = Math.max(1, Math.ceil(weeks / maxTicks));
	const out: string[] = [];
	for (let ms = start; ms <= lastMs; ms += step * 7 * DAY) out.push(isoDate(ms));
	return out;
}

/**
 * Indices into `labels` at which to draw x-axis ticks. For date-labeled series
 * these snap to month starts (long spans) or Monday-of-week (medium spans);
 * otherwise, and for non-date labels, ticks are evenly spaced.
 */
export function tickIndices(labels: string[], maxTicks = 7): number[] {
	const n = labels.length;
	if (n <= maxTicks) return labels.map((_, i) => i);

	const first = parseIso(labels[0]);
	const last = parseIso(labels[n - 1]);
	if (Number.isNaN(first) || Number.isNaN(last)) return evenIndices(n, maxTicks);

	const spanDays = (last - first) / DAY;
	let ticks: string[];
	if (spanDays > 45) ticks = monthTicks(first, last, maxTicks);
	else if (spanDays > 10) ticks = weekTicks(first, last, maxTicks);
	else return evenIndices(n, maxTicks);

	// Labels are sorted ISO strings: first label at/after each tick date.
	const idxs = dedupe(ticks.map((t) => labels.findIndex((l) => l >= t)).filter((i) => i >= 0));
	return idxs.length >= 2 ? idxs : evenIndices(n, maxTicks);
}
