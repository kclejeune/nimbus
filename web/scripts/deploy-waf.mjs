#!/usr/bin/env node
// Declarative zone-WAF deploy for the cache host: PUTs the two ruleset phase
// entrypoints (custom rules + rate limiting) with the desired rules, derived
// from wrangler.jsonc's CACHE_BASE_URL so no hostname is duplicated here.
//
// The phase-entrypoint PUT replaces the ENTIRE phase — this script owns every
// rule in http_request_firewall_custom and http_ratelimit for the zone, and
// rules added by hand in the dashboard under those phases are overwritten on
// the next run. That is the point: the file below is the desired state.
//
// Auth: WAF_API_TOKEN with "Zone > Zone > Read" and "Zone > Zone WAF > Edit"
// (a separate token from the analytics one, which cannot edit WAF). Injected
// via `fnox exec` (see fnox.toml at the repo root). Named distinctly from
// CLOUDFLARE_API_TOKEN so wrangler never picks it up over its OAuth session.
// Must be an API token (Bearer auth), not the legacy global API key.
//
// Usage:
//   node scripts/deploy-waf.mjs             # fail hard on missing token/API errors
//   node scripts/deploy-waf.mjs --optional  # warn and exit 0 when unconfigured,
//                                           # so `npm run deploy` never breaks on
//                                           # a machine without the WAF token
//
// Rule design notes (see the DDoS analysis in the repo history):
// - Actions are always "block": nix/attic clients cannot answer challenges.
// - The rate-limit rule is expressed by path shape, not host — the Free plan
//   only exposes Path in rate-limit expressions, and the binary-cache URL
//   space (.narinfo / /nar/) is distinctive enough to need no host match.
// - Free-plan rate limiting allows only period=10 and mitigation_timeout=10.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const optional = process.argv.includes('--optional');

function fail(message) {
	console.error(`deploy-waf: ${message}`);
	process.exit(optional ? 0 : 1);
}

/** Strip // and block comments from JSONC without touching string contents
 *  (URLs in strings contain `//`). Trailing commas are not used in our file. */
function stripJsonc(text) {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += text[++i] ?? '';
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = JSON.parse(stripJsonc(readFileSync(join(webDir, 'wrangler.jsonc'), 'utf8')));
const cacheBaseUrl = wrangler.vars?.CACHE_BASE_URL;
if (!cacheBaseUrl) fail('vars.CACHE_BASE_URL not found in wrangler.jsonc');
const cacheHost = new URL(cacheBaseUrl).host;

const token = process.env.WAF_API_TOKEN;
if (!token) {
	fail('WAF_API_TOKEN is not set (needs Zone:Read + Zone WAF:Edit); skipping WAF deploy');
}

async function api(method, path, body) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const json = await res.json().catch(() => null);
	if (!res.ok || !json?.success) {
		const errors = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ');
		throw new Error(`${method} ${path} failed (${res.status}): ${errors ?? 'unknown error'}`);
	}
	return json.result;
}

/** The zone is whichever the token can see whose name suffixes the cache
 *  host, so a host or zone rename needs no change here. */
async function findZone(host) {
	const labels = host.split('.');
	for (let i = 0; i < labels.length - 1; i++) {
		const name = labels.slice(i).join('.');
		const zones = await api('GET', `/zones?name=${encodeURIComponent(name)}`);
		if (zones.length > 0) return zones[0];
	}
	throw new Error(`no accessible zone matches ${host}`);
}

// --- desired state ----------------------------------------------------------

const customRules = [
	{
		description: 'cache: block query strings on read paths (cache-busting)',
		expression: `(http.host eq "${cacheHost}" and not starts_with(http.request.uri.path, "/_api/") and http.request.uri.query ne "")`,
		action: 'block',
		enabled: true
	},
	{
		description: 'cache: restrict methods to the binary-cache/attic protocol',
		expression: `(http.host eq "${cacheHost}" and not http.request.method in {"GET" "HEAD" "PUT" "POST" "DELETE" "PATCH"})`,
		action: 'block',
		enabled: true
	}
];

const ratelimitRules = [
	{
		description: 'cache: per-IP read flood backstop (narinfo + NAR paths)',
		expression:
			'(ends_with(http.request.uri.path, ".narinfo") or http.request.uri.path contains "/nar/")',
		action: 'block',
		enabled: true,
		ratelimit: {
			characteristics: ['ip.src', 'cf.colo.id'],
			period: 10,
			requests_per_period: 1000,
			mitigation_timeout: 10
		}
	}
];

// --- apply ------------------------------------------------------------------

async function putPhase(zoneId, phase, description, rules) {
	await api('PUT', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
		description,
		rules
	});
	console.log(`deploy-waf: ${phase}: ${rules.length} rule(s) applied`);
}

try {
	const zone = await findZone(cacheHost);
	await Promise.all([
		putPhase(
			zone.id,
			'http_request_firewall_custom',
			`nimbus cache abuse guards for ${cacheHost} (managed by scripts/deploy-waf.mjs)`,
			customRules
		),
		putPhase(
			zone.id,
			'http_ratelimit',
			`nimbus cache flood backstop (managed by scripts/deploy-waf.mjs)`,
			ratelimitRules
		)
	]);
	console.log(`deploy-waf: zone ${zone.name} up to date for ${cacheHost}`);
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}
