import { error, fail, redirect } from '@sveltejs/kit';
import { runGc, readGcLastRun } from '$lib/server/cache/gc';
import { requireAdmin } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { readSession } from '$lib/server/cache/db';
import { gibFieldToBytes } from '$lib/format';
import type { PageServerLoad, Actions } from './$types';

type Count = { n: number };

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	// Members land here from stale links; their settings live at /account.
	if (locals.user.role !== 'admin') redirect(302, '/account');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// The GC-candidate counts tolerate replica lag; the two server_config keys
	// stay on the primary because this page's own actions write them (the
	// reloaded value must reflect a just-saved limit / just-run GC).
	const read = readSession(db);
	const [pending, orphanNars, orphanChunks, globalLimit, gcLastRun] = await Promise.all([
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
		readGcLastRun(db)
	]);

	return {
		pendingNars: pending?.n ?? 0,
		orphanNars: orphanNars?.n ?? 0,
		orphanChunks: orphanChunks?.n ?? 0,
		globalMaxBytes: globalLimit ? Number(globalLimit.value) : null,
		gcLastRun
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

		const bytes = gibFieldToBytes((await request.formData()).get('global_max_gib'));
		if (bytes === undefined) {
			return fail(400, { limitError: 'Storage limit must be a positive number of GiB.' });
		}
		if (bytes === null) {
			await db.prepare("DELETE FROM server_config WHERE key = 'global_max_bytes'").run();
			return { limitSaved: true };
		}
		await db
			.prepare(
				"INSERT INTO server_config (key, value) VALUES ('global_max_bytes', ?1) " +
					'ON CONFLICT (key) DO UPDATE SET value = ?1'
			)
			.bind(String(bytes))
			.run();
		return { limitSaved: true };
	}
};
