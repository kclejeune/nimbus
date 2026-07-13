import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { isValidPublicKey } from '$lib/server/attic/signing';
import { normalizeUpstreamMode } from '$lib/server/cache/missing-paths';
import {
	createUpstream,
	deleteUpstream,
	listRegistry,
	registryUsage,
	updateUpstream,
	type UpstreamInput
} from '$lib/server/cache/upstream-registry';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform, locals }) => {
	requireAdmin(locals);
	const db = platform?.env.ATTIC_DB;
	if (!db) throw error(500, 'Database binding unavailable');

	const [registry, usage] = await Promise.all([listRegistry(db), registryUsage(db)]);
	return {
		upstreams: registry.map((u) => ({
			...u,
			ttlHours: u.ttl === null ? '' : String(Math.round(u.ttl / 3600)),
			usage: usage.get(u.id) ?? { redirect: 0, persist: 0 }
		}))
	};
};

/** Validate the shared add/update form fields into an UpstreamInput. */
function parseUpstreamInput(form: FormData): UpstreamInput | { error: string } {
	const url = String(form.get('url') ?? '')
		.trim()
		.replace(/\/+$/, '');
	if (!url) return { error: 'Upstream URL is required.' };
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return { error: `Upstream URL must be http(s): ${url}` };
		}
	} catch {
		return { error: `Invalid upstream URL: ${url}` };
	}

	const key = String(form.get('public_key') ?? '').trim();
	if (key && !isValidPublicKey(key)) {
		return { error: `Invalid public key (expected name:base64…): ${key}` };
	}

	const ttlRaw = String(form.get('ttl_hours') ?? '').trim();
	const ttlHours = ttlRaw === '' ? null : Number(ttlRaw);
	if (ttlHours !== null && (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 8760)) {
		return { error: `TTL must be between 1 hour and 1 year (in hours): ${ttlRaw}` };
	}

	const defaultMode = normalizeUpstreamMode(String(form.get('default_mode') ?? 'redirect'));
	const enforced = form.get('enforced') === 'on';
	if (enforced && defaultMode === 'off') {
		return { error: 'An enforced upstream cannot default to off.' };
	}

	return {
		url,
		publicKey: key || null,
		ttl: ttlHours === null ? null : Math.round(ttlHours * 3600),
		defaultMode,
		enforced
	};
}

export const actions: Actions = {
	add: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const input = parseUpstreamInput(await request.formData());
		if ('error' in input) return fail(400, { error: input.error });

		// Registry writers purge the edge-cached passthroughs themselves.
		if (!(await createUpstream(platform.env.ATTIC_DB, input, { ctx: platform.ctx }))) {
			return fail(409, { error: `${input.url} is already registered.` });
		}
		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user!.id,
			action: 'upstream.add',
			target: input.url
		});
		return { saved: true };
	},

	update: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid upstream id.' });
		const input = parseUpstreamInput(form);
		if ('error' in input) return fail(400, { error: input.error });

		await updateUpstream(platform.env.ATTIC_DB, id, input, { ctx: platform.ctx });
		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user!.id,
			action: 'upstream.update',
			target: input.url
		});
		return { saved: true };
	},

	remove: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');

		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid upstream id.' });

		await deleteUpstream(platform.env.ATTIC_DB, id, { ctx: platform.ctx });
		await writeAudit(platform.env.ATTIC_DB, {
			userId: locals.user!.id,
			action: 'upstream.remove',
			target: String(form.get('url') ?? id)
		});
		return { saved: true };
	}
};
