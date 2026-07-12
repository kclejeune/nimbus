import type { D1Database } from '@cloudflare/workers-types';

/** Best-effort audit trail write; failures are logged, never surfaced. */
export async function writeAudit(
	db: D1Database,
	entry: { userId: string | null; action: string; target?: string; detail?: string }
): Promise<void> {
	try {
		await db
			.prepare(
				`INSERT INTO audit_log (id, user_id, action, target, detail, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
			)
			.bind(
				crypto.randomUUID(),
				entry.userId,
				entry.action,
				entry.target ?? null,
				entry.detail ?? null,
				Math.floor(Date.now() / 1000)
			)
			.run();
	} catch (e) {
		console.warn(`audit write failed (${entry.action}): ${e}`);
	}
}
