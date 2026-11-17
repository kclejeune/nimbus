import { uiRead } from '$lib/server/ui-read-cache';
import {
	startClosureCheck,
	stepClosureCheck,
	pauseClosureCheck,
	readClosureCheck,
	readMaintenanceResult,
	saveMaintenanceResult
} from '$lib/server/maintenance-ui';
import { error, fail, redirect, isRedirect } from '@sveltejs/kit';
import {
	queueGc,
	readGcOperation,
	continueScheduledGc,
	readGcLastRun,
	readGlobalMaxBytes
} from '$lib/server/cache/gc';
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

export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	// Members land here from stale links; their settings live at /account.
	if (locals.user.role !== 'admin') redirect(302, '/account');
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	// Fresh loads read only small status/config rows. Full graph/orphan
	// scans belong to paced maintenance, never to refreshing this page.
	const userId = locals.user.id;
	const [limit, last, caches, operation, check, maintenance] = await Promise.all([
		uiRead(db, 'editable-storage-limit', () => readGlobalMaxBytes(db), null, 0),
		uiRead(db, 'gc-summary', () => readGcLastRun(db), null, 0),
		uiRead(
			db,
			'cache-list',
			async () =>
				(
					await readSession(db)
						.prepare('SELECT id,name FROM cache WHERE deleted_at IS NULL ORDER BY name')
						.all<{ id: number; name: string }>()
				).results,
			[] as { id: number; name: string }[]
		),
		uiRead(db, 'gc-operation', () => readGcOperation(db), null, 0),
		uiRead(db, 'closure-check:' + userId, () => readClosureCheck(db, userId), null, 0),
		uiRead(
			db,
			'closure-result:' + userId,
			() => readMaintenanceResult(platform!.env, userId),
			null,
			0
		)
	]);
	return {
		isAdmin: true,
		globalMaxBytes: limit.value,
		gcLastRun: last.value,
		closureCaches: caches.value,
		gcOperation: operation.value,
		closureCheck: check.value,
		maintenance: maintenance.value,
		dataUnavailable: [limit, last, caches, operation, check, maintenance].some(
			(r) => r.stale || r.unavailable
		),
		limitUnavailable: limit.stale || limit.unavailable
	};
};

export const actions: Actions = {
	startClosureCheck: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const scope = String((await request.formData()).get('cache') ?? '');
		if (scope !== '*' && !CACHE_NAME_RE.test(scope))
			return fail(400, { maintenanceError: 'Select one cache or all caches.' });
		try {
			return actionResult(request, {
				closureCheck: await startClosureCheck(platform.env, locals.user!.id, scope)
			});
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(maintenanceStatus(e), { maintenanceError: maintenanceMessage(e) });
		}
	},
	continueClosureCheck: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const id = String((await request.formData()).get('id') ?? '');
		try {
			return actionResult(request, {
				closureCheck: await stepClosureCheck(
					platform.env,
					locals.user!.id,
					id,
					request.headers.get('CF-Connecting-IP')
				)
			});
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(maintenanceStatus(e), {
				maintenanceError: 'Progress is saved. The service is busy; resume shortly.'
			});
		}
	},
	pauseClosureCheck: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const id = String((await request.formData()).get('id') ?? '');
		try {
			return actionResult(request, {
				closureCheck: await pauseClosureCheck(platform.env.ATTIC_DB, locals.user!.id, id)
			});
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(maintenanceStatus(e), { maintenanceError: maintenanceMessage(e) });
		}
	},

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
			await saveMaintenanceResult(platform.env.ATTIC_DB, locals.user!.id, {
				preview: closurePreview
			});
			await writeAudit(platform.env.ATTIC_DB, {
				userId: locals.user!.id,
				action: 'cache.integrity.check',
				target: cache,
				detail: `Checked ${closurePreview.inspection.references.length} dependencies`
			});
			return actionResult(request, { closurePreview });
		} catch (e) {
			if (isRedirect(e)) throw e;
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
			await saveMaintenanceResult(platform.env.ATTIC_DB, locals.user!.id, {
				preview: { inspection, token },
				removing: true
			});
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
			await saveMaintenanceResult(platform.env.ATTIC_DB, locals.user!.id, {
				preview: { inspection, token },
				purge: closurePurge
			});
			return actionResult(request, { closurePreview: { inspection, token }, closurePurge });
		} catch (e) {
			if (isRedirect(e)) throw e;
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
			const gcOperation = await queueGc(platform.env, dryRun);
			platform.ctx.waitUntil(continueScheduledGc(platform.env, platform.ctx));
			if (!dryRun)
				await writeAudit(platform.env.ATTIC_DB, { userId: locals.user!.id, action: 'gc.trigger' });
			return actionResult(request, { gcOperation });
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(502, {
				gcError:
					'Maintenance could not be queued. Retry shortly or refresh to check whether it was accepted.'
			});
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
	return error instanceof ClosureMaintenanceError
		? error.message
		: 'The service is temporarily busy. Progress is saved; retry shortly.';
}

function actionResult<T>(request: Request, result: T): T {
	if (!request.headers.get('accept')?.includes('application/json')) redirect(303, '/settings');
	return result;
}
