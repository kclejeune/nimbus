import { error, fail } from '@sveltejs/kit';
import { runGc } from '$lib/server/attic/gc';
import type { PageServerLoad, Actions } from './$types';

type Count = { n: number };

export const load: PageServerLoad = async ({ platform }) => {
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [caches, objects, nars, storage, pending, orphanNars, orphanChunks, globalLimit] =
		await Promise.all([
			db.prepare('SELECT COUNT(*) AS n FROM cache WHERE deleted_at IS NULL').first<Count>(),
			db
				.prepare(
					'SELECT COUNT(*) AS n FROM object o JOIN cache c ON c.id = o.cache_id WHERE c.deleted_at IS NULL'
				)
				.first<Count>(),
			db.prepare("SELECT COUNT(*) AS n FROM nar WHERE state = 'V'").first<Count>(),
			db
				.prepare("SELECT COALESCE(SUM(file_size), 0) AS n FROM chunk WHERE state = 'V'")
				.first<Count>(),
			db.prepare("SELECT COUNT(*) AS n FROM nar WHERE state = 'P'").first<Count>(),
			db
				.prepare(
					'SELECT COUNT(*) AS n FROM nar n WHERE NOT EXISTS (SELECT 1 FROM object o WHERE o.nar_id = n.id)'
				)
				.first<Count>(),
			db
				.prepare(
					'SELECT COUNT(*) AS n FROM chunk WHERE NOT EXISTS (SELECT 1 FROM chunkref cr WHERE cr.chunk_id = chunk.id)'
				)
				.first<Count>(),
			db
				.prepare("SELECT value FROM server_config WHERE key = 'global_max_bytes'")
				.first<{ value: string }>()
		]);

	return {
		stats: {
			caches: caches?.n ?? 0,
			objects: objects?.n ?? 0,
			nars: nars?.n ?? 0,
			storageBytes: storage?.n ?? 0,
			pendingNars: pending?.n ?? 0,
			orphanNars: orphanNars?.n ?? 0,
			orphanChunks: orphanChunks?.n ?? 0
		},
		globalMaxBytes: globalLimit ? Number(globalLimit.value) : null
	};
};

export const actions: Actions = {
	gc: async ({ request, locals, platform }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (locals.user.role !== 'admin') throw error(403, 'Admins only');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const dryRun = (await request.formData()).get('dry_run') === '1';
		try {
			const gcStats = (await runGc(platform.env, { dryRun })) as Record<string, number>;
			return { gcStats, dryRun };
		} catch (e) {
			return fail(502, { gcError: `Garbage collection failed: ${e}` });
		}
	},

	saveLimit: async ({ request, locals, platform }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (locals.user.role !== 'admin') throw error(403, 'Admins only');
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
