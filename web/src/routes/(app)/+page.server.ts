import { error } from '@sveltejs/kit';
import { readGcLastRun } from '$lib/server/cache/gc';
import { allLiveUpstreams } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { readSession } from '$lib/server/cache/db';
import { instanceStats } from '$lib/server/cache/stats';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// Read-only dashboard (the GC and limit actions live on /settings), so
	// everything reads a replica session.
	const read = readSession(db);

	// Daily ingest series for the chart: last 90 days, zero-filled below.
	const DAY_MS = 86400_000;
	const ingestSince = new Date(Date.now() - 90 * DAY_MS).toISOString().slice(0, 10);
	const ingestStmt = read
		.prepare(
			`SELECT date(o.created_at) AS bucket, COUNT(*) AS paths,
			        COALESCE(SUM(ch.file_size), 0) AS bytes
			 FROM object o
			 JOIN nar n ON n.id = o.nar_id
			 JOIN chunkref cr ON cr.nar_id = n.id
			 JOIN chunk ch ON ch.id = cr.chunk_id
			 WHERE o.created_at >= ?1
			 GROUP BY bucket ORDER BY bucket`
		)
		.bind(ingestSince);

	const [stats, globalLimit, gcLastRun, ingest, proxyPublicKey, proxyUpstreams] = await Promise.all(
		[
			instanceStats(read),
			read
				.prepare("SELECT value FROM server_config WHERE key = 'global_max_bytes'")
				.first<{ value: string }>(),
			readGcLastRun(read),
			ingestStmt.all<{ bucket: string; paths: number; bytes: number }>(),
			platform?.env
				? getProxyKeypair(platform.env)
						.then(extractPublicKey)
						.catch(() => null)
				: null,
			allLiveUpstreams(read)
		]
	);

	// Zero-fill so the chart doesn't interpolate across idle days.
	const byDay = new Map(ingest.results.map((r) => [r.bucket, r]));
	const buckets: { date: string; paths: number; bytes: number }[] = [];
	for (let ms = new Date(ingestSince).getTime(); ms <= Date.now(); ms += DAY_MS) {
		const day = new Date(ms).toISOString().slice(0, 10);
		const row = byDay.get(day);
		buckets.push({ date: day, paths: row?.paths ?? 0, bytes: row?.bytes ?? 0 });
	}

	return {
		stats,
		globalMaxBytes: globalLimit ? Number(globalLimit.value) : null,
		gcLastRun,
		buckets,
		cacheBaseUrl: platform?.env.CACHE_BASE_URL ?? null,
		proxyPublicKey,
		proxyUpstreams: proxyUpstreams.map((u) => ({
			url: u.url,
			publicKey: u.publicKey,
			nixDefault: u.nixDefault
		}))
	};
};
