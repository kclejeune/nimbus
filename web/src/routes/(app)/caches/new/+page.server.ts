import { fail, redirect, error } from '@sveltejs/kit';
import { atticFetch, adminAccess } from '$lib/server/attic-api';
import { CACHE_NAME_RE } from '$lib/utils';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, locals, platform }) => {
		if (!locals.user) throw error(401, 'Not signed in');
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const isPublic = form.get('is_public') === 'on';
		const priority = Number(form.get('priority') ?? 40);
		const compression = String(form.get('compression') ?? 'zstd');
		const retentionRaw = String(form.get('retention_period') ?? '').trim();
		const retention = retentionRaw === '' ? null : Number(retentionRaw);

		if (!CACHE_NAME_RE.test(name)) {
			return fail(400, {
				error: 'Name must be lowercase alphanumeric with dashes (max 50 chars).',
				values: { name, isPublic, priority, compression, retentionRaw }
			});
		}

		const res = await atticFetch(
			platform.env,
			{ userId: locals.user.id, caches: adminAccess() },
			`/_api/v1/cache-config/${encodeURIComponent(name)}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					is_public: isPublic,
					priority,
					compression,
					retention_period: retention
				})
			}
		);

		if (!res.ok) {
			const detail = await res.text();
			return fail(res.status === 409 ? 409 : 502, {
				error:
					res.status === 409
						? `A cache named "${name}" already exists.`
						: `Failed to create cache: ${detail}`,
				values: { name, isPublic, priority, compression, retentionRaw }
			});
		}

		redirect(303, `/caches/${name}`);
	}
};
