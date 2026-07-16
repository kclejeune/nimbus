import { error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

interface AuditRow {
	id: string;
	action: string;
	target: string | null;
	detail: string | null;
	created_at: number;
	user_name: string | null;
	user_email: string | null;
}

export const load: PageServerLoad = async ({ platform, locals, url }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const page = Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1);

	// One row past the page detects "next" without a second scan per request;
	// the total drives the "X–Y of N" footer.
	const [{ results }, total] = await Promise.all([
		db
			.prepare(
				`SELECT a.id, a.action, a.target, a.detail, a.created_at,
				        u.name AS user_name, u.email AS user_email
				 FROM audit_log a
				 LEFT JOIN user u ON u.id = a.user_id
				 ORDER BY a.created_at DESC, a.id DESC
				 LIMIT ?1 OFFSET ?2`
			)
			.bind(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
			.all<AuditRow>(),
		db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>()
	]);

	return {
		page,
		pageSize: PAGE_SIZE,
		total: total?.n ?? 0,
		hasMore: results.length > PAGE_SIZE,
		entries: results.slice(0, PAGE_SIZE).map((r) => ({
			id: r.id,
			action: r.action,
			target: r.target,
			detail: r.detail,
			createdAt: r.created_at,
			// Null for system-initiated actions and unresolvable user ids alike.
			user: r.user_name || r.user_email || null
		}))
	};
};
