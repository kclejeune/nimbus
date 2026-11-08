import { SignJWT, jwtVerify } from 'jose';
import { clientKey, requireBudgetUnits } from './admission';
import { findCache, STORE_PATH_HASH_RE } from './db';
import { checkReferences, uncoveredReferences } from './closure-repair';
import { applyPurge, purgePlan, readPurgeUpstreams, type PurgeTarget } from './closure-purge';
import type { ExecutionContext } from './platform';

type Env = App.Platform['env'];
const PREVIEW_AUDIENCE = 'nimbus:closure-maintenance:v1';
const MAX_REFERENCES = 25;
const MAX_PROBES = 100;
const MAX_PREVIEW_BYTES = 512 * 1024;

export class ClosureMaintenanceError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
	}
}

export interface ClosureInspection {
	cache: { id: number; name: string };
	checkedAt: string;
	operationId: string;
	after: string;
	references: {
		hash: string;
		store_path: string;
		referrers: number;
		status: 'missing' | 'unverified' | 'covered';
	}[];
	nextCursor: string | null;
	objects: PurgeTarget[];
	truncated: boolean;
}

export interface ClosurePreview {
	inspection: ClosureInspection;
	token: string;
}

function previewKey(env: Env): Uint8Array {
	const secret = env.SESSION_SECRET || env.JWT_HS256_SECRET_BASE64;
	if (!secret)
		throw new ClosureMaintenanceError('Maintenance previews require a signing secret.', 503);
	return new TextEncoder().encode(`${PREVIEW_AUDIENCE}:${secret}`);
}

async function maintenanceCache(env: Env, name: string) {
	const cache = await findCache(env.ATTIC_DB, name);
	if (!cache) throw new ClosureMaintenanceError('This cache no longer exists.', 404);
	return cache;
}

async function maintenanceBudget(env: Env, ip: string | null) {
	await requireBudgetUnits(env.BATCH_QUERY_LIMITER, clientKey('batch-query', ip), 1);
}

/** Admin UI workflow over the same graph, upstream checks and purge planner as
 * the CLI. One bounded reference page per request; no local Nix store access. */
export async function inspectClosures(
	env: Env,
	userId: string,
	cacheName: string,
	after = '',
	ip: string | null = null
): Promise<ClosurePreview> {
	if (after && !STORE_PATH_HASH_RE.test(after))
		throw new ClosureMaintenanceError('Invalid dependency cursor.');
	await maintenanceBudget(env, ip);
	const cache = await maintenanceCache(env, cacheName);
	const { upstreams } = await readPurgeUpstreams(env.ATTIC_DB, cache.id, cache.name);
	if (upstreams.length > MAX_PROBES)
		throw new ClosureMaintenanceError(
			'This cache has too many upstreams for a dashboard check. Use the CLI.',
			409
		);
	const pageSize = Math.min(
		MAX_REFERENCES,
		Math.max(1, Math.floor(MAX_PROBES / Math.max(1, upstreams.length)))
	);
	const page = await uncoveredReferences(env.ATTIC_DB, cache.id, upstreams, after, pageSize);
	const hashes = page.references.map((r) => r.hash);
	const checked = await checkReferences(
		env.ATTIC_DB,
		cache.name,
		upstreams,
		hashes,
		{ env, ip },
		true
	);
	const missing = new Set(checked.missing),
		unverified = new Set(checked.unverified);
	const plan = await purgePlan(env.ATTIC_DB, cache.id, checked.missing);
	const inspection: ClosureInspection = {
		cache: { id: cache.id, name: cache.name },
		checkedAt: new Date().toISOString(),
		operationId: crypto.randomUUID(),
		after,
		references: page.references.map((r) => ({
			...r,
			status: missing.has(r.hash) ? 'missing' : unverified.has(r.hash) ? 'unverified' : 'covered'
		})),
		nextCursor: page.next_cursor,
		objects: plan.objects,
		truncated: plan.next_cursor !== null
	};
	// Bind reviewed identities to this admin and a short lifetime. The browser
	// cannot add targets, change caches or turn an incomplete preview into apply.
	const token = await new SignJWT({ inspection })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience(PREVIEW_AUDIENCE)
		.setSubject(userId)
		.setIssuedAt()
		.setExpirationTime('15m')
		.sign(previewKey(env));
	if (token.length > MAX_PREVIEW_BYTES)
		throw new ClosureMaintenanceError(
			'This preview is too large for the dashboard. Use nimbus purge to review it.',
			413
		);
	return { inspection, token };
}

export async function readClosurePreview(
	env: Env,
	userId: string,
	token: string
): Promise<ClosureInspection> {
	if (!token || token.length > MAX_PREVIEW_BYTES)
		throw new ClosureMaintenanceError('Check dependencies before removing paths.');
	try {
		const { payload } = await jwtVerify(token, previewKey(env), {
			algorithms: ['HS256'],
			audience: PREVIEW_AUDIENCE,
			subject: userId,
			requiredClaims: ['exp', 'iat', 'sub']
		});
		if (!payload.inspection || typeof payload.inspection !== 'object')
			throw new Error('Missing preview');
		return payload.inspection as unknown as ClosureInspection;
	} catch {
		throw new ClosureMaintenanceError(
			'This preview expired or changed. Check dependencies again.',
			409
		);
	}
}

export async function applyClosurePreview(
	env: Env,
	ctx: ExecutionContext | undefined,
	inspection: ClosureInspection,
	ip: string | null = null
) {
	if (inspection.truncated)
		throw new ClosureMaintenanceError(
			'Review the complete plan with nimbus purge before removing paths.',
			409
		);
	const targets = inspection.objects.filter((o) => !o.blocked);
	if (targets.length === 0)
		throw new ClosureMaintenanceError('There are no removable paths in this preview.');
	await maintenanceBudget(env, ip);
	const cache = await maintenanceCache(env, inspection.cache.name);
	if (cache.id !== inspection.cache.id)
		throw new ClosureMaintenanceError('This cache was replaced. Check dependencies again.', 409);
	const { upstreams } = await readPurgeUpstreams(env.ATTIC_DB, cache.id, cache.name);
	const hashes = inspection.references.filter((r) => r.status === 'missing').map((r) => r.hash);
	if (hashes.length * upstreams.length > MAX_PROBES)
		throw new ClosureMaintenanceError(
			'Upstream configuration changed. Check dependencies again.',
			409
		);
	const checked = await checkReferences(
		env.ATTIC_DB,
		cache.name,
		upstreams,
		hashes,
		{ env, ip },
		true
	);
	if (checked.unverified.length > 0)
		throw new ClosureMaintenanceError(
			'Upstream availability could not be verified. Nothing was removed; check dependencies again.',
			503
		);
	// The atomic guard rechecks current coverage, pins, upload age and reviewed
	// object identities; concurrent repairs or new dependents can only retain more.
	return applyPurge(
		env,
		ctx,
		cache.id,
		cache.name,
		checked.missing,
		targets,
		inspection.operationId
	);
}
