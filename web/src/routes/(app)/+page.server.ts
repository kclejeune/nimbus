import { error, fail } from '@sveltejs/kit';
import { runGc, type GcLastRun } from '$lib/server/cache/gc';
import { allLiveUpstreams } from '$lib/server/cache/missing-paths';
import { getProxyKeypair } from '$lib/server/cache/proxy';
import { extractPublicKey } from '$lib/server/attic/signing';
import { requireAdmin } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { readSession } from '$lib/server/cache/db';
import type { PageServerLoad, Actions } from './$types';

type Count = { n: number };

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// The heavy aggregations read a replica session; the two server_config
	// keys stay on the primary because this page's own actions write them
	// (the reloaded value must reflect a just-saved limit / just-run GC).
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

	const [
		caches,
		objects,
		nars,
		storage,
		logical,
		pending,
		orphanNars,
		orphanChunks,
		globalLimit,
		gcLastRunRow,
		ingest,
		proxyPublicKey,
		proxyUpstreams
	] = await Promise.all([
		read.prepare('SELECT COUNT(*) AS n FROM cache WHERE deleted_at IS NULL').first<Count>(),
		read
			.prepare(
				'SELECT COUNT(*) AS n FROM object o JOIN cache c ON c.id = o.cache_id WHERE c.deleted_at IS NULL'
			)
			.first<Count>(),
		read.prepare("SELECT COUNT(*) AS n FROM nar WHERE state = 'V'").first<Count>(),
		read
			.prepare("SELECT COALESCE(SUM(file_size), 0) AS n FROM chunk WHERE state = 'V'")
			.first<Count>(),
		// Logical bytes: every object's NAR counted once per reference. The
		// excess over physical storage is what NAR- and chunk-level dedup saves.
		read
			.prepare(
				'SELECT COALESCE(SUM(sz.bytes), 0) AS n FROM object o ' +
					'JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr ' +
					'JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz ON sz.nar_id = o.nar_id'
			)
			.first<Count>(),
		read.prepare("SELECT COUNT(*) AS n FROM nar WHERE state = 'P'").first<Count>(),
		read
			.prepare(
				'SELECT COUNT(*) AS n FROM nar n WHERE NOT EXISTS (SELECT 1 FROM object o WHERE o.nar_id = n.id)'
			)
			.first<Count>(),
		read
			.prepare(
				'SELECT COUNT(*) AS n FROM chunk WHERE NOT EXISTS (SELECT 1 FROM chunkref cr WHERE cr.chunk_id = chunk.id)'
			)
			.first<Count>(),
		db
			.prepare("SELECT value FROM server_config WHERE key = 'global_max_bytes'")
			.first<{ value: string }>(),
		db
			.prepare("SELECT value FROM server_config WHERE key = 'gc_last_run'")
			.first<{ value: string }>(),
		ingestStmt.all<{ bucket: string; paths: number; bytes: number }>(),
		platform?.env
			? getProxyKeypair(platform.env)
					.then(extractPublicKey)
					.catch(() => null)
			: null,
		allLiveUpstreams(read)
	]);

	// Written by GC's persistLastRun; absent until the first real run, and a
	// malformed value is treated the same rather than breaking the page.
	let gcLastRun: GcLastRun | null = null;
	if (gcLastRunRow) {
		try {
			gcLastRun = JSON.parse(gcLastRunRow.value) as GcLastRun;
		} catch {
			gcLastRun = null;
		}
	}

	// Zero-fill so the chart doesn't interpolate across idle days.
	const byDay = new Map(ingest.results.map((r) => [r.bucket, r]));
	const buckets: { date: string; paths: number; bytes: number }[] = [];
	for (let ms = new Date(ingestSince).getTime(); ms <= Date.now(); ms += DAY_MS) {
		const day = new Date(ms).toISOString().slice(0, 10);
		const row = byDay.get(day);
		buckets.push({ date: day, paths: row?.paths ?? 0, bytes: row?.bytes ?? 0 });
	}

	return {
		stats: {
			caches: caches?.n ?? 0,
			objects: objects?.n ?? 0,
			nars: nars?.n ?? 0,
			storageBytes: storage?.n ?? 0,
			logicalBytes: logical?.n ?? 0,
			pendingNars: pending?.n ?? 0,
			orphanNars: orphanNars?.n ?? 0,
			orphanChunks: orphanChunks?.n ?? 0
		},
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

export const actions: Actions = {
	gc: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const dryRun = (await request.formData()).get('dry_run') === '1';
		try {
			const gcStats = (await runGc(platform.env, { dryRun })) as Record<string, number>;
			if (!dryRun) {
				await writeAudit(platform.env.ATTIC_DB, { userId: locals.user!.id, action: 'gc.trigger' });
			}
			return { gcStats, dryRun };
		} catch (e) {
			return fail(502, { gcError: `Garbage collection failed: ${e}` });
		}
	},

	saveLimit: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const raw = String((await request.formData()).get('global_max_gib') ?? '').trim();
		if (raw === '') {
			await db.prepare("DELETE FROM server_config WHERE key = 'global_max_bytes'").run();
			return { limitSaved: true };
		}
		const gib = Number(raw);
		if (!Number.isFinite(gib) || gib <= 0) {
			return fail(400, { limitError: 'Storage limit must be a positive number of GiB.' });
		}
		await db
			.prepare(
				"INSERT INTO server_config (key, value) VALUES ('global_max_bytes', ?1) " +
					'ON CONFLICT (key) DO UPDATE SET value = ?1'
			)
			.bind(String(Math.round(gib * 2 ** 30)))
			.run();
		return { limitSaved: true };
	}
};
