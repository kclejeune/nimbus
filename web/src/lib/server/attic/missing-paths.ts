// POST /_api/v1/get-missing-paths, ported from the Rust worker and extended
// with upstream filtering: paths already fetchable from the cache's configured
// upstream binary caches (cache.upstream_caches, default cache.nixos.org) are
// not reported as missing, so clients never push them here. Verdicts are
// cached in upstream_check (present = long-lived, absent = rechecked daily).

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];

const BATCH = 99;
/** Max live upstream narinfo probes per request (Workers subrequest budget). */
const MAX_UPSTREAM_PROBES = 250;
const PROBE_CONCURRENCY = 10;
const ABSENT_RECHECK_MS = 24 * 60 * 60 * 1000;

export async function findExistingPaths(
	db: D1,
	cacheName: string,
	hashes: string[]
): Promise<Set<string>> {
	const existing = new Set<string>();
	for (let i = 0; i < hashes.length; i += BATCH) {
		const batch = hashes.slice(i, i + BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		const rows = (
			await db
				.prepare(
					'SELECT o.store_path_hash FROM object o ' +
						'INNER JOIN cache c ON o.cache_id = c.id ' +
						'INNER JOIN nar n ON o.nar_id = n.id ' +
						"WHERE c.name = ?1 AND c.deleted_at IS NULL AND n.state = 'V' " +
						`AND o.store_path_hash IN (${placeholders})`
				)
				.bind(cacheName, ...batch)
				.all<{ store_path_hash: string }>()
		).results;
		for (const row of rows) existing.add(row.store_path_hash);
	}
	return existing;
}

/** Cached upstream verdicts for a batch of hashes: hash -> present. */
async function cachedVerdicts(
	db: D1,
	upstream: string,
	hashes: string[]
): Promise<Map<string, boolean>> {
	const verdicts = new Map<string, boolean>();
	const absentCutoff = Date.now() - ABSENT_RECHECK_MS;
	for (let i = 0; i < hashes.length; i += BATCH) {
		const batch = hashes.slice(i, i + BATCH);
		const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
		const rows = (
			await db
				.prepare(
					'SELECT store_path_hash, present, checked_at FROM upstream_check ' +
						`WHERE upstream = ?1 AND store_path_hash IN (${placeholders})`
				)
				.bind(upstream, ...batch)
				.all<{ store_path_hash: string; present: number; checked_at: string }>()
		).results;
		for (const row of rows) {
			// Stale "absent" verdicts are dropped so the path gets re-probed.
			if (row.present === 0 && Date.parse(row.checked_at) < absentCutoff) continue;
			verdicts.set(row.store_path_hash, row.present === 1);
		}
	}
	return verdicts;
}

async function recordVerdicts(
	db: D1,
	upstream: string,
	verdicts: { hash: string; present: boolean }[]
): Promise<void> {
	const now = new Date().toISOString();
	// 4 bind params per row, stay under D1's 100-param limit.
	const ROWS_PER_STMT = 24;
	for (let i = 0; i < verdicts.length; i += ROWS_PER_STMT) {
		const batch = verdicts.slice(i, i + ROWS_PER_STMT);
		const values = batch.map(
			(_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4})`
		);
		const params = batch.flatMap((v) => [upstream, v.hash, v.present ? 1 : 0, now]);
		await db
			.prepare(
				'INSERT OR REPLACE INTO upstream_check (upstream, store_path_hash, present, checked_at) ' +
					`VALUES ${values.join(', ')}`
			)
			.bind(...params)
			.run();
	}
}

/**
 * Filter out hashes that exist in any configured upstream. Probes are capped
 * per request; anything over the cap is conservatively treated as missing
 * (worst case the client pushes a path we could have skipped).
 */
export async function filterUpstreamPaths(
	db: D1,
	upstreams: string[],
	missing: string[]
): Promise<string[]> {
	let remaining = missing;
	let probeBudget = MAX_UPSTREAM_PROBES;

	for (const rawUpstream of upstreams) {
		if (remaining.length === 0) break;
		const upstream = rawUpstream.replace(/\/+$/, '');

		const cached = await cachedVerdicts(db, upstream, remaining);
		const unknown = remaining.filter((h) => !cached.has(h));

		const toProbe = unknown.slice(0, probeBudget);
		probeBudget -= toProbe.length;
		const probed: { hash: string; present: boolean }[] = [];
		for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
			const batch = toProbe.slice(i, i + PROBE_CONCURRENCY);
			const results = await Promise.all(
				batch.map(async (hash) => {
					try {
						const res = await fetch(`${upstream}/${hash}.narinfo`, { method: 'HEAD' });
						if (res.status === 200) return { hash, present: true };
						if (res.status === 404) return { hash, present: false };
						return null; // transient upstream trouble: no verdict, treat as missing
					} catch {
						return null;
					}
				})
			);
			probed.push(...results.filter((r): r is { hash: string; present: boolean } => r !== null));
		}
		if (probed.length > 0) {
			await recordVerdicts(db, upstream, probed).catch((e) =>
				console.warn(`upstream_check record failed: ${e}`)
			);
		}

		const present = new Set<string>();
		for (const [hash, p] of cached) if (p) present.add(hash);
		for (const v of probed) if (v.present) present.add(v.hash);
		remaining = remaining.filter((h) => !present.has(h));
	}

	return remaining;
}

export function parseUpstreams(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : [];
	} catch {
		return [];
	}
}
