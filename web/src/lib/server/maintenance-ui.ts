import { dbFirst, dbRun, isTransientD1Error } from './cache/db';
import {
	ClosureMaintenanceError,
	inspectClosures,
	readClosurePreview,
	type ClosurePreview
} from './cache/closure-maintenance';

type Env = App.Platform['env'];
type D1 = Env['ATTIC_DB'];
export interface CacheCheckResult {
	id: number;
	name: string;
	state: 'queued' | 'checking' | 'complete';
	scanned: number;
	checked: number;
	missing: number;
	unverified: number;
	/** Cursor before the first finding, for an explicit, fresh removal review. */
	firstFinding?: string;
}
export interface ClosureCheck {
	id: string;
	scope: string;
	state: 'running' | 'paused' | 'complete';
	startedAt: string;
	updatedAt: string;
	index: number;
	after: string;
	caches: CacheCheckResult[];
	message?: string;
	lease?: string;
	leaseUntil?: number;
}
const checkKey = (userId: string) => `ui:closure-check:${userId}`;
const resultKey = (userId: string) => `ui:closure-result:${userId}`;
const LEASE_MS = 90_000;
const saveJson = (db: D1, key: string, value: unknown) =>
	dbRun(
		db
			.prepare(
				'INSERT INTO server_config(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
			)
			.bind(key, JSON.stringify(value))
	);

async function readJson<T>(db: D1, key: string): Promise<T | null> {
	const row = await dbFirst<{ value: string }>(
		db.prepare('SELECT value FROM server_config WHERE key=?1').bind(key)
	);
	return row ? (JSON.parse(row.value) as T) : null;
}
export const readClosureCheck = (db: D1, userId: string) =>
	readJson<ClosureCheck>(db, checkKey(userId));

/** Called only after requireAdmin. One persisted check per admin; no browser
 * session token, cross-request I/O promise or new scheduler is needed. */
export async function startClosureCheck(
	env: Env,
	userId: string,
	scope: string
): Promise<ClosureCheck> {
	const statement =
		scope === '*'
			? env.ATTIC_DB.prepare(
					'SELECT id,name FROM cache WHERE deleted_at IS NULL ORDER BY name LIMIT 501'
				)
			: env.ATTIC_DB.prepare('SELECT id,name FROM cache WHERE deleted_at IS NULL AND name=?1').bind(
					scope
				);
	const { results } = await statement.all<{ id: number; name: string }>();
	if (!results.length) throw new ClosureMaintenanceError('No caches are available to check.', 404);
	if (results.length > 500)
		throw new ClosureMaintenanceError(
			'Select a cache to check this instance in smaller groups.',
			413
		);
	const now = new Date().toISOString();
	const check: ClosureCheck = {
		id: crypto.randomUUID(),
		scope,
		state: 'running',
		startedAt: now,
		updatedAt: now,
		index: 0,
		after: '',
		caches: results.map((cache) => ({
			...cache,
			state: 'queued',
			scanned: 0,
			checked: 0,
			missing: 0,
			unverified: 0
		}))
	};
	await saveJson(env.ATTIC_DB, checkKey(userId), check);
	return check;
}

export async function stepClosureCheck(
	env: Env,
	userId: string,
	id: string,
	ip: string | null
): Promise<ClosureCheck> {
	const db = env.ATTIC_DB,
		key = checkKey(userId);
	const check = await readClosureCheck(db, userId);
	if (!check || check.id !== id)
		throw new ClosureMaintenanceError('This check was replaced. Start a new check.', 409);
	if (check.state === 'complete' || (check.leaseUntil ?? 0) > Date.now()) return check;
	const before = JSON.stringify(check);
	const working: ClosureCheck = {
		...check,
		state: 'running',
		lease: crypto.randomUUID(),
		leaseUntil: Date.now() + LEASE_MS
	};
	const claimed = JSON.stringify(working);
	const claim = await dbRun(
		db
			.prepare('UPDATE server_config SET value=?2 WHERE key=?1 AND value=?3')
			.bind(key, claimed, before),
		{ attempts: 1 }
	);
	if (!claim.meta.changes) return (await readClosureCheck(db, userId))!;
	try {
		const cache = working.caches[working.index];
		const preview = await inspectClosures(env, userId, cache.name, working.after, ip, {
			plan: false,
			pageLimit: 10
		});
		const report = preview.inspection;
		if (report.cache.id !== cache.id)
			throw new ClosureMaintenanceError('This cache was replaced. Start a new check.', 409);
		cache.state = 'checking';
		cache.scanned += report.scannedHashes ?? report.references.length;
		cache.checked += report.references.length;
		cache.missing += report.references.filter((r) => r.status === 'missing').length;
		cache.unverified += report.references.filter((r) => r.status === 'unverified').length;
		if (cache.firstFinding === undefined && report.references.some((r) => r.status !== 'covered'))
			cache.firstFinding = working.after;
		if (report.nextCursor) working.after = report.nextCursor;
		else {
			cache.state = 'complete';
			working.index++;
			working.after = '';
		}
		if (working.index === working.caches.length) working.state = 'complete';
		delete working.message;
	} catch (error) {
		working.state = 'paused';
		working.message =
			error instanceof ClosureMaintenanceError
				? error.message
				: 'The service is busy. Your progress is saved; resume shortly.';
		if (!isTransientD1Error(error, true) && !(error instanceof ClosureMaintenanceError))
			console.warn(
				JSON.stringify({
					event: 'nimbus.closure_check',
					status: 'paused',
					errorType: error instanceof Error ? error.name : 'unknown'
				})
			);
	}
	delete working.lease;
	delete working.leaseUntil;
	working.updatedAt = new Date().toISOString();
	const saved = await dbRun(
		db
			.prepare('UPDATE server_config SET value=?2 WHERE key=?1 AND value=?3')
			.bind(key, JSON.stringify(working), claimed),
		{ attempts: 1 }
	);
	return saved.meta.changes ? working : (await readClosureCheck(db, userId))!;
}

export async function pauseClosureCheck(db: D1, userId: string, id: string): Promise<ClosureCheck> {
	const check = await readClosureCheck(db, userId);
	if (!check || check.id !== id) throw new ClosureMaintenanceError('This check was replaced.', 409);
	if (check.state !== 'complete') {
		const before = JSON.stringify(check);
		check.state = 'paused';
		delete check.lease;
		delete check.leaseUntil;
		check.updatedAt = new Date().toISOString();
		const result = await dbRun(
			db
				.prepare('UPDATE server_config SET value=?2 WHERE key=?1 AND value=?3')
				.bind(checkKey(userId), JSON.stringify(check), before),
			{ attempts: 1 }
		);
		if (!result.meta.changes) return (await readClosureCheck(db, userId))!;
	}
	return check;
}

export interface MaintenanceResult {
	preview: ClosurePreview;
	removing?: boolean;
	purge?: { removed: number; pending_purge: boolean };
	message?: string;
	expired?: boolean;
}
export const saveMaintenanceResult = (db: D1, userId: string, result: MaintenanceResult) =>
	saveJson(db, resultKey(userId), result);
export async function readMaintenanceResult(
	env: Env,
	userId: string
): Promise<MaintenanceResult | null> {
	const result = await readJson<MaintenanceResult>(env.ATTIC_DB, resultKey(userId));
	if (!result) return null;
	if (result.removing || result.purge) {
		const receipt = await dbFirst<{ removed: number; state: string }>(
			env.ATTIC_DB.prepare('SELECT removed,state FROM path_purge WHERE id=?1').bind(
				result.preview.inspection.operationId
			)
		);
		if (receipt && receipt.state !== 'pending') {
			result.purge = { removed: receipt.removed, pending_purge: receipt.state !== 'done' };
			result.removing = false;
		}
	}
	if (result.removing && !result.purge)
		result.message =
			'The last removal outcome is not yet confirmed. You can safely retry the reviewed removal.';
	if (!result.purge) {
		try {
			await readClosurePreview(env, userId, result.preview.token);
		} catch {
			return {
				...result,
				expired: true,
				message: 'This removal preview expired. Check dependencies again before removing paths.'
			};
		}
	}
	return result;
}
