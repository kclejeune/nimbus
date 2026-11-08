import { error, fail, redirect } from '@sveltejs/kit';
import { runGc, readGcLastRun, readGlobalMaxBytes } from '$lib/server/cache/gc';
import { requireAdmin } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { readSession } from '$lib/server/cache/db';
import { gibFieldToBytes } from '$lib/format';
import {
	applyClosurePreview,
	ClosureMaintenanceError,
	inspectClosures,
	readClosurePreview
} from '$lib/server/cache/closure-maintenance';
import { AdmissionError } from '$lib/server/cache/admission';
import { CACHE_NAME_RE } from '$lib/utils';
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
	const [pending, orphanNars, orphanChunks, globalMaxBytes, gcLastRun, closureCaches] =
		await Promise.all([
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
			readGlobalMaxBytes(db),
			readGcLastRun(db),
			read
				.prepare('SELECT id, name FROM cache WHERE deleted_at IS NULL ORDER BY name')
				.all<{ id: number; name: string }>()
		]);

	return {
		pendingNars: pending?.n ?? 0,
		orphanNars: orphanNars?.n ?? 0,
		orphanChunks: orphanChunks?.n ?? 0,
		globalMaxBytes,
		gcLastRun,
		closureCaches: closureCaches.results
	};
};

export const actions: Actions = {
	inspectClosures: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const fields = await request.formData();
		const cache = String(fields.get('cache') ?? '');
		if (!CACHE_NAME_RE.test(cache))
			return fail(400, { maintenanceError: 'Select a cache to check.' });
		try {
			const closurePreview = await inspectClosures(
				platform.env,
				locals.user!.id,
				cache,
				String(fields.get('after') ?? ''),
				request.headers.get('CF-Connecting-IP')
			);
			await writeAudit(platform.env.ATTIC_DB, {
				userId: locals.user!.id,
				action: 'cache.integrity.check',
				target: cache,
				detail: `Checked ${closurePreview.inspection.references.length} dependencies`
			});
			return { closurePreview };
		} catch (e) {
			return fail(maintenanceStatus(e), {
				maintenanceError: `Dependency check failed: ${maintenanceMessage(e)}`
			});
		}
	},
	purgeClosures: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const field = (await request.formData()).get('preview');
		const token = typeof field === 'string' ? field : '';
		let inspection;
		try {
			inspection = await readClosurePreview(platform.env, locals.user!.id, token);
			const closurePurge = await applyClosurePreview(
				platform.env,
				platform.ctx,
				inspection,
				request.headers.get('CF-Connecting-IP')
			);
			await writeAudit(platform.env.ATTIC_DB, {
				userId: locals.user!.id,
				action: 'cache.integrity.purge',
				target: inspection.cache.name,
				detail: `Removed ${closurePurge.removed} reviewed paths; edge invalidation pending: ${closurePurge.pending_purge}`
			});
			return { closurePreview: { inspection, token }, closurePurge };
		} catch (e) {
			return fail(maintenanceStatus(e), {
				maintenanceError: `Path removal failed: ${maintenanceMessage(e)}`,
				...(inspection ? { closurePreview: { inspection, token } } : {})
			});
		}
	},
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

function maintenanceStatus(error: unknown) {
	return error instanceof ClosureMaintenanceError
		? error.status
		: error instanceof AdmissionError
			? 503
			: 502;
}

function maintenanceMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
