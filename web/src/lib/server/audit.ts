import type { D1Database } from '@cloudflare/workers-types';
import { getDb, schema } from './db';

/** Best-effort audit trail write; failures are logged, never surfaced. */
export async function writeAudit(
	db: D1Database,
	entry: { userId: string | null; action: string; target?: string; detail?: string }
): Promise<void> {
	try {
		await getDb(db)
			.insert(schema.auditLog)
			.values({
				id: crypto.randomUUID(),
				userId: entry.userId,
				action: entry.action,
				target: entry.target ?? null,
				detail: entry.detail ?? null,
				createdAt: new Date()
			});
	} catch (e) {
		console.warn(`audit write failed (${entry.action}): ${e}`);
	}
}
