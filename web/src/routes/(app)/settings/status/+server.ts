import { json, error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { readGcOperation, readGcLastRun } from '$lib/server/cache/gc';
import { dbFirst, isTransientD1Error } from '$lib/server/cache/db';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ locals, platform, url }) => {
	requireAdmin(locals);
	if (!platform?.env) throw error(503, 'Service temporarily unavailable');
	try {
		const db = platform.env.ATTIC_DB;
		const gcOperation = await readGcOperation(db);
		const id = url.searchParams.get('operation');
		const receipt =
			id && /^[0-9a-f-]{36}$/i.test(id)
				? await dbFirst<{ removed: number; state: string }>(
						db.prepare('SELECT removed,state FROM path_purge WHERE id=?1').bind(id)
					)
				: null;
		return json(
			{
				gcOperation,
				gcLastRun:
					gcOperation?.state === 'complete' && !gcOperation.dryRun
						? await readGcLastRun(db)
						: undefined,
				closurePurge:
					receipt && receipt.state !== 'pending'
						? { id, removed: receipt.removed, pending_purge: receipt.state !== 'done' }
						: null
			},
			{ headers: { 'Cache-Control': 'private, no-store' } }
		);
	} catch (e) {
		if (isTransientD1Error(e, true))
			throw error(503, 'The service is busy. Your operation and progress are saved.');
		throw e;
	}
};
