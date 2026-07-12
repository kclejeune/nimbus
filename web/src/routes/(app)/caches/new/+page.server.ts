import { fail, redirect, error } from '@sveltejs/kit';
import { CacheConfigError, createCache } from '$lib/server/cache/cache-config';
import { writeAudit } from '$lib/server/audit';
import { CACHE_NAME_RE } from '$lib/utils';
import type { Actions } from './$types';

export const actions: Actions = {
	// Creating a cache is open to any active user (hooks.server.ts walls off
	// non-active users); the creator receives full control of what they create.
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

		try {
			await createCache(
				platform.env,
				name,
				{
					is_public: isPublic,
					priority,
					compression,
					retention_period: retention
				},
				locals.user.id
			);
		} catch (e) {
			const status = e instanceof CacheConfigError ? e.status : 502;
			return fail(status, {
				error:
					status === 409
						? `A cache named "${name}" already exists.`
						: `Failed to create cache: ${e instanceof Error ? e.message : e}`,
				values: { name, isPublic, priority, compression, retentionRaw }
			});
		}

		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user.id,
			action: 'cache.create',
			target: name
		});

		redirect(303, `/caches/${name}`);
	}
};
