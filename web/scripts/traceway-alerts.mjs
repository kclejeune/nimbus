// Generate a dashboard-console installer. This command makes no network calls
// and never reads credentials; application runs in the user's signed-in browser.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{channel: JsonObject, objectives: {key: string, body: JsonObject}[], rules: {sloKey: string, body: JsonObject}[]}} AlertPlan */

/** @param {AlertPlan} plan @param {string} projectId @param {string} origin */
async function install(plan, projectId, origin) {
	if (window.location.origin !== origin)
		throw new Error(`Open ${origin} before running this installer.`);
	const token = localStorage.getItem('AUTH_TOKEN');
	if (!token) throw new Error('Sign in to the Traceway dashboard first.');
	/** @param {string} path @param {string} [method] @param {JsonObject} [body] */
	const api = async (path, method = 'GET', body) => {
		const url = new URL(`/api/${path}`, origin);
		url.searchParams.set('projectId', projectId);
		const response = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!response.ok)
			throw new Error(
				`${method} /api/${path}: HTTP ${response.status}. No credential or access-policy changes were attempted.`
			);
		return response.json();
	};
	// Resolve every required read before creating anything. Older servers lack
	// span SLOs; an agent token cannot create configuration even with write scope.
	const [channelList, sloList, ruleList] = await Promise.all([
		api('notification-channels'),
		api('slos'),
		api('notification-rules')
	]);
	/** @param {JsonObject} payload @param {string} key @returns {JsonObject[]} */
	const list = (payload, key) => {
		if (!Object.hasOwn(payload, key) || (payload[key] !== null && !Array.isArray(payload[key])))
			throw new Error(`Unexpected ${key} response; no configuration was created.`);
		return payload[key] ?? [];
	};
	const channels = list(channelList, 'channels');
	const objectives = list(sloList, 'slos');
	const rules = list(ruleList, 'rules');
	/** @param {unknown} value */
	const decode = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
	/** @param {unknown} expected @param {unknown} actual @returns {boolean} */
	const matches = (expected, actual) => {
		if (expected === null || typeof expected !== 'object') return expected === actual;
		if (actual === null || typeof actual !== 'object') return false;
		if (Array.isArray(expected) && (!Array.isArray(actual) || expected.length !== actual.length))
			return false;
		return Object.entries(expected).every(([key, value]) =>
			matches(value, /** @type {Record<string, unknown>} */ (actual)[key])
		);
	};
	/** @param {string} path @param {JsonObject[]} entries @param {JsonObject} body @returns {Promise<JsonObject>} */
	const ensure = async (path, entries, body) => {
		const found = entries.filter((item) => item.name === body.name);
		if (found.length > 1)
			throw new Error(`Duplicate existing name: ${body.name}. Review in the dashboard.`);
		if (found.length) {
			const existing = { ...found[0] };
			for (const key of ['config', 'sliConfig'])
				if (existing[key]) existing[key] = decode(existing[key]);
			if (existing.enabled === false || !matches(body, existing))
				throw new Error(
					`Existing settings differ for ${body.name}; left unchanged. Review in the dashboard.`
				);
			return existing;
		}
		const created = await api(path, 'POST', body);
		if (!Number.isSafeInteger(created.id) || created.id < 1)
			throw new Error(
				`No numeric id returned for ${body.name}. Check the dashboard before retrying.`
			);
		console.log(`Created ${body.name} (id ${created.id})`);
		return created;
	};
	const channel = await ensure('notification-channels', channels, plan.channel);
	const slos = new Map();
	for (const objective of plan.objectives) {
		const slo = await ensure('slos', objectives, objective.body);
		slos.set(objective.key, slo.id);
	}
	for (const rule of plan.rules) {
		const sloId = slos.get(rule.sloKey);
		if (!sloId) throw new Error(`Unknown SLO reference ${rule.sloKey}`);
		await ensure('notification-rules', rules, {
			...rule.body,
			channelId: channel.id,
			config: { ...rule.body.config, sloId }
		});
	}
	console.log(
		'Nimbus performance objectives and email alert rules are configured. No test email was sent.'
	);
}

/** @param {AlertPlan} plan @param {string} projectId @param {string} origin @param {string} recipient */
export function installer(plan, projectId, origin, recipient) {
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId ?? ''))
		throw new Error('Provide the Traceway project UUID.');
	const url = new URL(origin);
	if (url.protocol !== 'https:' && url.hostname !== 'localhost')
		throw new Error('Use an HTTPS Traceway origin.');
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient ?? ''))
		throw new Error('Set TRACEWAY_ALERT_RECIPIENT to the alert email address locally.');
	const configured = {
		...plan,
		channel: { ...plan.channel, config: { ...plan.channel.config, recipients: [recipient] } }
	};
	return `(${install.toString()})(${JSON.stringify(configured)},${JSON.stringify(projectId)},${JSON.stringify(url.origin)})`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const plan = JSON.parse(
		readFileSync(new URL('../../docs/traceway-performance.json', import.meta.url), 'utf8')
	);
	console.log(
		installer(
			plan,
			process.argv[2],
			process.argv[3] ?? 'https://traceway.kclj.io',
			process.env.TRACEWAY_ALERT_RECIPIENT ?? ''
		)
	);
}
