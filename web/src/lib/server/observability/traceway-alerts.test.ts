import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { installer } from '../../../../scripts/traceway-alerts.mjs';

const plan = JSON.parse(
	readFileSync(new URL('../../../../../docs/traceway-performance.json', import.meta.url), 'utf8')
);
const project = '2295639f-73fa-43d3-a439-23a18b19c51b';
const origin = 'https://traceway.test';
const WIRE_KEY: Record<string, string> = {
	'notification-channels': 'channels',
	'notification-rules': 'rules',
	slos: 'slos'
};

function dashboard(unsupported = false) {
	const records: Record<string, Record<string, unknown>[]> = {
		'notification-channels': [],
		slos: [],
		'notification-rules': []
	};
	const fetch = vi.fn(async (url: URL, options: RequestInit) => {
		expect(url.origin).toBe(origin);
		expect(url.searchParams.get('projectId')).toBe(project);
		const path = url.pathname.split('/').at(-1)!;
		if (unsupported && path === 'slos') return { ok: false, status: 404 };
		if (options.method === 'GET')
			return {
				ok: true,
				json: async () => ({ [WIRE_KEY[path]]: records[path] })
			};
		const body = JSON.parse(options.body as string);
		const row = { ...body, id: records[path].length + 1, enabled: true };
		records[path].push(row);
		return { ok: true, json: async () => row };
	});
	const context = {
		window: { location: { origin } },
		localStorage: { getItem: () => 'dashboard-test-token' },
		fetch,
		URL,
		console: { log: vi.fn() }
	};
	const run = () => runInNewContext(installer(plan, project, origin, 'ops@example.test'), context);
	return { records, fetch, context, run };
}

it('creates the email channel, header SLOs and rules once, then reuses matching configuration', async () => {
	const { records, fetch, run } = dashboard();
	await run();
	expect(records['notification-channels']).toMatchObject([
		{ config: { recipients: ['ops@example.test'] } }
	]);
	expect(records.slos).toHaveLength(6);
	expect(records['notification-rules']).toHaveLength(8);
	const posts = () => fetch.mock.calls.filter(([, options]) => options.method === 'POST');
	expect(posts()).toHaveLength(15);
	await run();
	expect(posts()).toHaveLength(15);
	expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith('/test'))).toBe(false);
});

it('makes no changes if the installed server lacks SLO support', async () => {
	const { fetch, run } = dashboard(true);
	await expect(run()).rejects.toThrow('HTTP 404');
	expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});

it('does not overwrite an existing channel with different recipients', async () => {
	const { records, fetch, run } = dashboard();
	records['notification-channels'].push({
		...plan.channel,
		config: { recipients: ['other@example.test'] },
		id: 1,
		enabled: true
	});
	await expect(run()).rejects.toThrow('Existing settings differ');
	expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});

it('never uses a dashboard credential on a different origin', async () => {
	const { fetch, context, run } = dashboard();
	context.window.location.origin = 'https://other.test';
	await expect(run()).rejects.toThrow('Open https://traceway.test');
	expect(fetch).not.toHaveBeenCalled();
});
