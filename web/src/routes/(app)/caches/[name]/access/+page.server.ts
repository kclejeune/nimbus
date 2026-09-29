import { error, fail } from '@sveltejs/kit';
import {
	canOnCache,
	parseGrantActions,
	partitionCacheGrants,
	type CacheGrantRow
} from '$lib/server/auth/permissions';
import { decodeSubject, encodeSubject, insertGrant, removeGrantRow } from '$lib/server/auth/grants';
import { effectiveAccessOf, requireAdmin } from '$lib/server/auth/guard';
import { getCache, rowsByIds } from '$lib/server/cache/cache-page';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, params, locals }) => {
	const env = platform?.env;
	if (!env) throw error(500, 'Platform bindings unavailable');

	const [cache, access] = await Promise.all([
		getCache(env.ATTIC_DB, params.name),
		effectiveAccessOf(locals, env.ATTIC_DB)
	]);
	const canConfigure = canOnCache(access, 'cr', params.name);
	const canDestroy = canOnCache(access, 'cd', params.name);
	// A management surface: pull-only users have nothing to do here.
	if (!canConfigure && !canDestroy) throw error(403, 'Permission denied');

	const isAdmin = locals.user!.role === 'admin';
	const [grantRows, adminUsers, adminGroups] = await Promise.all([
		// Only this cache's exact-name rows and glob rows can apply here (see
		// partitionCacheGrants) — other caches' exact grants never match.
		env.ATTIC_DB.prepare(
			`SELECT id, subject_type, subject_id, pattern, actions FROM permission_grant
			 WHERE pattern = ?1 OR pattern GLOB '*[*?]*'`
		)
			.bind(params.name)
			.all<CacheGrantRow>(),
		// Admins get the full lists (they also feed the add-access picker).
		isAdmin
			? env.ATTIC_DB.prepare('SELECT id, name, email FROM user ORDER BY name').all<{
					id: string;
					name: string;
					email: string;
				}>()
			: null,
		isAdmin
			? env.ATTIC_DB.prepare('SELECT id, name FROM groups ORDER BY name').all<{
					id: string;
					name: string;
				}>()
			: null
	]);

	const { direct, viaPatterns } = partitionCacheGrants(grantRows.results, params.name);
	const applicable = [...direct, ...viaPatterns];

	// Emails are admin-only PII; non-admin viewers see display names, resolved
	// only for the subjects that actually appear on this page.
	const subjectIds = (type: string) => [
		...new Set(applicable.filter((g) => g.subject_type === type).map((g) => g.subject_id))
	];
	const [users, groupRows] = isAdmin
		? [adminUsers!.results, adminGroups!.results]
		: await Promise.all([
				rowsByIds<{ id: string; name: string; email: string }>(
					env.ATTIC_DB,
					'SELECT id, name, email FROM user',
					subjectIds('user')
				),
				rowsByIds<{ id: string; name: string }>(
					env.ATTIC_DB,
					'SELECT id, name FROM groups',
					subjectIds('group')
				)
			]);
	const userLabel = new Map(users.map((u) => [u.id, isAdmin ? `${u.name} (${u.email})` : u.name]));
	const groupLabel = new Map(groupRows.map((g) => [g.id, g.name]));
	const subjectLabel = (g: CacheGrantRow) =>
		(g.subject_type === 'user' ? userLabel.get(g.subject_id) : groupLabel.get(g.subject_id)) ??
		g.subject_id;
	const describe = (g: CacheGrantRow) => ({
		id: g.id,
		subjectType: g.subject_type,
		subjectId: g.subject_id,
		subjectLabel: subjectLabel(g),
		pattern: g.pattern,
		actions: g.actions
	});

	return {
		isPublic: cache.is_public !== 0,
		isAdmin,
		// Direct (exact-name, editable here) rows first, then read-only rows
		// contributed by glob patterns.
		access: [
			...direct.map((g) => ({ ...describe(g), direct: true })),
			...viaPatterns.map((g) => ({ ...describe(g), direct: false }))
		],
		subjects: isAdmin
			? [
					...users.map((u) => ({
						value: encodeSubject('user', u.id),
						label: `${u.name} (${u.email})`
					})),
					...groupRows.map((g) => ({
						value: encodeSubject('group', g.id),
						label: `${g.name} (group)`
					}))
				]
			: []
	};
};

export const actions: Actions = {
	accessAdd: async ({ request, locals, platform, params }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const form = await request.formData();
		const subject = decodeSubject(String(form.get('subject') ?? ''));
		if (!subject) return fail(400, { accessError: 'Pick a user or group.' });
		const actions = parseGrantActions(form);
		if (Object.keys(actions).length === 0) {
			return fail(400, { accessError: 'Pick at least one permission.' });
		}
		await insertGrant(db, {
			subjectType: subject.type,
			subjectId: subject.id,
			pattern: params.name,
			actions,
			actorId: locals.user!.id
		});
		return { accessSaved: true };
	},

	accessRemove: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const subjectType = String(form.get('subject_type') ?? '');
		const subjectId = String(form.get('subject_id') ?? '');
		if (subjectType !== 'user' && subjectType !== 'group') {
			return fail(400, { accessError: 'Invalid subject.' });
		}
		await removeGrantRow(db, id, subjectType, subjectId, locals.user!.id);
		return { accessSaved: true };
	}
};
