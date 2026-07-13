import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { writeAudit } from '$lib/server/audit';
import { isValidPublicKey } from '$lib/server/attic/signing';
import { formatDuration, parseDuration } from '$lib/duration';
import { normalizeUpstreamMode } from '$lib/server/cache/missing-paths';
import {
	createUpstream,
	deleteUpstream,
	listRegistry,
	registryUsage,
	setUpstreamPositions,
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
			ttlText: formatDuration(u.ttl),
			usage: usage.get(u.id) ?? { redirect: 0, persist: 0 }
		}))
	};
};

/** Validate the shared add/save form fields into an UpstreamInput. The save
 * form carries every entry at once, namespaced by `_<id>` suffix. */
function parseUpstreamInput(form: FormData, suffix = ''): UpstreamInput | { error: string } {
	const url = String(form.get(`url${suffix}`) ?? '')
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

	// Trust without a key is unverifiable — every upstream must have one.
	const key = String(form.get(`public_key${suffix}`) ?? '').trim();
	if (!key) {
		return { error: `A public key is required for ${url} — upstream trust is key-based.` };
	}
	if (!isValidPublicKey(key)) {
		return { error: `Invalid public key (expected name:base64…): ${key}` };
	}

	const ttlRaw = String(form.get(`ttl${suffix}`) ?? '').trim();
	if (!ttlRaw) {
		return { error: `A TTL is required for ${url} — e.g. 3600s, 90m, 720h, 30d, or 1y.` };
	}
	const ttl = parseDuration(ttlRaw);
	if (ttl === null) {
		return { error: `Invalid TTL "${ttlRaw}" — use a duration like 3600s, 90m, 720h, 30d, or 1y.` };
	}
	if (ttl < 60 || ttl > 31536000) {
		return { error: `TTL must be between 1 minute and 1 year: ${ttlRaw}` };
	}

	const defaultMode = normalizeUpstreamMode(
		String(form.get(`default_mode${suffix}`) ?? 'redirect')
	);
	const enforced = form.get(`enforced${suffix}`) === 'on';
	if (enforced && defaultMode === 'off') {
		return { error: 'An enforced upstream cannot default to off.' };
	}
	const nixDefault = form.get(`nix_default${suffix}`) === 'on';

	return { url, publicKey: key, ttl, defaultMode, enforced, nixDefault };
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

	/** Page-level save: every rendered entry posts at once; only entries whose
	 * values actually changed hit the DB (updateUpstream wipes verdicts on
	 * url/key changes, so no-op writes must not reach it). */
	save: async ({ request, locals, platform }) => {
		requireAdmin(locals);
		if (!platform?.env) throw error(500, 'Platform bindings unavailable');
		const db = platform.env.ATTIC_DB;

		const form = await request.formData();
		const registry = await listRegistry(db);
		const changed: string[] = [];
		const positions: { id: number; position: number }[] = [];
		for (const entry of registry) {
			if (form.get(`url_${entry.id}`) === null) continue; // not rendered (stale form)
			const input = parseUpstreamInput(form, `_${entry.id}`);
			if ('error' in input) return fail(400, { error: input.error });

			const posRaw = Number(form.get(`position_${entry.id}`));
			positions.push({
				id: entry.id,
				position: Number.isInteger(posRaw) ? posRaw : entry.position
			});

			if (
				input.url === entry.url &&
				input.publicKey === entry.publicKey &&
				input.ttl === entry.ttl &&
				input.defaultMode === entry.defaultMode &&
				input.enforced === entry.enforced &&
				input.nixDefault === entry.nixDefault
			) {
				continue;
			}
			await updateUpstream(db, entry.id, input, { ctx: platform.ctx });
			changed.push(input.url);
		}

		// Reorder only when the submitted order differs from the stored one
		// (registry is already position-sorted).
		const orderedIds = positions.sort((a, b) => a.position - b.position).map((p) => p.id);
		const currentIds = registry
			.filter((e) => positions.some((p) => p.id === e.id))
			.map((e) => e.id);
		if (orderedIds.join(',') !== currentIds.join(',')) {
			await setUpstreamPositions(db, orderedIds, { ctx: platform.ctx });
			changed.push('(reordered)');
		}

		if (changed.length > 0) {
			await writeAudit(db, {
				userId: locals.user!.id,
				action: 'upstream.update',
				target: changed.join(', ')
			});
		}
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
