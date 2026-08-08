#!/usr/bin/env node
// Declarative zone-WAF deploy for both hosts: PUTs the two ruleset phase
// entrypoints (custom rules + rate limiting) with the desired rules, derived
// from the wrangler config's CACHE_BASE_URL and APP_URL (wrangler.local.jsonc
// when present, else wrangler.jsonc) so no hostname is duplicated here.
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
//   node scripts/deploy-waf.mjs             # also fail on an unconfigured token
//   node scripts/deploy-waf.mjs --optional  # skip (exit 0) when no token is set,
//                                           # so `npm run deploy` never breaks on
//                                           # a machine without the WAF token
//
// --optional covers "this machine cannot deploy WAF", nothing else. An API
// error is always exit 1 even under it: swallowing one leaves the zone half
// applied — one phase updated, the other silently stale — while the deploy
// reports success, which is exactly how the rule-count ceiling below went
// unnoticed through a full `npm run deploy`.
//
// Rule design notes (see the DDoS analysis in the repo history):
// - Actions are always "block": nix/attic clients cannot answer challenges.
// - The rate-limit rule is expressed by path shape, not host — the Free plan
//   only exposes Path in rate-limit expressions, and the binary-cache URL
//   space (.narinfo / /nar/) is distinctive enough to need no host match.
// - Free-plan rate limiting allows only period=10 and mitigation_timeout=10,
//   and ONE rule in the phase — see ratelimitRules for what that costs.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const optional = process.argv.includes('--optional');

/** Unconfigured: not an error under --optional. */
function skip(message) {
	console.error(`deploy-waf: ${message}`);
	process.exit(optional ? 0 : 1);
}

/** Something went wrong with a deploy that was supposed to happen. Always loud. */
function fail(message) {
	console.error(`deploy-waf: ${message}`);
	process.exit(1);
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
// Same precedence as the deploy scripts: an untracked wrangler.local.jsonc
// (per-deployment values) wins over the tracked template.
const configPath = ['wrangler.local.jsonc', 'wrangler.jsonc']
	.map((name) => join(webDir, name))
	.find(existsSync);
const wrangler = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8')));
const cacheBaseUrl = wrangler.vars?.CACHE_BASE_URL;
if (!cacheBaseUrl) skip('vars.CACHE_BASE_URL not found in wrangler.jsonc');
const cacheHost = new URL(cacheBaseUrl).host;
// The admin host is optional only so a config without APP_URL still deploys
// the cache rules; when it is set it gets its own coverage below. Both hosts
// are expected to sit in the same zone (findZone resolves from cacheHost).
const appUrl = wrangler.vars?.APP_URL;
const appHost = appUrl ? new URL(appUrl).host : null;
const hosts = appHost ? [cacheHost, appHost] : [cacheHost];

const token = process.env.WAF_API_TOKEN;
if (!token) {
	skip('WAF_API_TOKEN is not set (needs Zone:Read + Zone WAF:Edit); skipping WAF deploy');
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

/** Geo gate by continent — OFF by default. The shape allowlist above kills
 *  junk at the edge regardless of origin, the per-IP rate limit bounds
 *  honest-shaped floods, and a worldwide cache beats the lockout risk (the
 *  gate covered the ADMIN host too, stranding a travelling admin). Kept
 *  wired because it is the one lever the other rules cannot replace: a
 *  distributed flood of protocol-VALID requests bills a worker invocation
 *  each no matter what the shape rules say, and blocking whole continents at
 *  the edge is what actually cuts that bill. Under sustained attack: set
 *  true, narrow the list, `npm run deploy:waf`. (ip.src.continent codes
 *  NA/SA/EU/AS/AF/OC/AN; Tor exits report "T1" and are implicitly blocked
 *  while the gate is on.) */
const GEO_RESTRICT = false;
const ALLOWED_CONTINENTS = ['NA', 'SA', 'EU'];

/** Always-block junk shared by both hosts: non-protocol methods (the allowlist
 *  omits OPTIONS, which is fine only while the app is same-origin — add it
 *  before adding any cross-origin API, or preflights die at the edge with no
 *  application-level trace), oversized paths (fake nar-path shapes die before
 *  the worker's 256-char verdict guard), and known crawlers — never nix
 *  clients, and on the admin host a private UI with nothing to index, so every
 *  crawl is a billed request that also runs a session lookup. */
const JUNK_SHAPES =
	`not http.request.method in {"GET" "HEAD" "PUT" "POST" "DELETE" "PATCH"} or ` +
	`len(http.request.uri.path) > 300 or ` +
	`cf.client.bot`;

/** Path-shape allowlist for the cache host. The binary-cache URL space is
 *  closed and machine-generated — router.ts serves exactly these shapes — so
 *  scanner probes (`/wp-login.php`, hash-shaped names with a bogus extension,
 *  truncated NAR paths) can die at the edge unbilled instead of 404ing in the
 *  worker. The Free plan has no regex (`matches` is Business+), so the hash
 *  charset can't be checked; suffix allowlists plus length floors carry the
 *  weight:
 *  - .narinfo: the store-path hash is exactly 32 chars (serveNarInfo rejects
 *    others), so a valid path is at least "/<32>.narinfo" = 41 chars; the
 *    per-cache form only adds length.
 *  - NAR paths: every emitter — buildNarInfo (64-hex or 52-base32 nar hash),
 *    standard upstreams (52-char base32 file hash), FlakeHub-style deep paths
 *    (nar/<32>/sha256:<64-hex>.nar) — yields at least "/nar/<52>.nar" = 61
 *    chars, and the compression suffix set is fixed (compressionExtension in
 *    attic/narinfo.ts, plus legacy .bz2 upstream paths).
 *  A ≥52-char junk hash with a valid suffix still clears both floors — that
 *  residue is the worker's cheap 404/400, not the WAF's problem to solve.
 *  Non-GET/HEAD methods are only legitimate under /_api/ (upload + admin
 *  API), so elsewhere they block outright. `nix log` fetches (/log/<drv>)
 *  are deliberately absent: the router has always 404ed them.
 */
const NAR_SUFFIXES = ['.nar', '.nar.zst', '.nar.xz', '.nar.gz', '.nar.br', '.nar.bz2'];
const CACHE_READ_SHAPES =
	`http.request.uri.path eq "/" or ` +
	// Browsers landing on the cache host (redirected to the app by the router)
	// ask for this; let it 404 in the worker rather than surface a WAF block.
	`http.request.uri.path eq "/favicon.ico" or ` +
	`ends_with(http.request.uri.path, "/nix-cache-info") or ` +
	`ends_with(http.request.uri.path, "/attic-cache-info") or ` +
	`starts_with(http.request.uri.path, "/_api/") or ` +
	`(ends_with(http.request.uri.path, ".narinfo") and len(http.request.uri.path) >= 41) or ` +
	`(http.request.uri.path contains "/nar/" and len(http.request.uri.path) >= 61 and (` +
	NAR_SUFFIXES.map((s) => `ends_with(http.request.uri.path, "${s}")`).join(' or ') +
	`))`;

// One rule per host rather than one over both: the cache host adds a
// query-string clause the dashboard cannot take (it uses ?page/?q/?cache
// legitimately). Same action throughout, so the clauses OR-combine losslessly.
// Both are kept separate from the geo gate below so Security > Events can
// distinguish shape junk from geography when hunting false positives —
// geography is the only clause a legit user could ever trip. The Free plan
// caps this phase at 5 rules; this file deploys 3 with the geo gate off,
// 4 with it on.
const customRules = [
	{
		description: 'cache: junk shapes (query-string, method, oversized path, bots)',
		expression:
			`(http.host eq "${cacheHost}" and (` +
			`(not starts_with(http.request.uri.path, "/_api/") and http.request.uri.query ne "") or ` +
			`${JUNK_SHAPES}))`,
		action: 'block',
		enabled: true
	},
	{
		description: 'cache: paths outside the binary-cache protocol shapes',
		expression:
			`(http.host eq "${cacheHost}" and (` +
			`(http.request.method in {"GET" "HEAD"} and not (${CACHE_READ_SHAPES})) or ` +
			`(not http.request.method in {"GET" "HEAD"} and not starts_with(http.request.uri.path, "/_api/"))` +
			`))`,
		action: 'block',
		enabled: true
	}
];

if (appHost) {
	customRules.push({
		description: 'app: junk shapes (method, oversized path, bots)',
		expression: `(http.host eq "${appHost}" and (${JUNK_SHAPES}))`,
		action: 'block',
		enabled: true
	});
}

if (GEO_RESTRICT) {
	const list = ALLOWED_CONTINENTS.map((c) => `"${c}"`).join(' ');
	const hostSet = hosts.map((h) => `"${h}"`).join(' ');
	customRules.push({
		description: 'geo gate by continent, both hosts (GEO_RESTRICT in deploy-waf.mjs)',
		expression: `(http.host in {${hostSet}} and not ip.src.continent in {${list}})`,
		action: 'block',
		enabled: true
	});
}

// EXACTLY ONE rule fits: the Free plan's http_ratelimit phase holds a single
// entry (a second PUTs back "50001: exceeded the maximum number of rules in
// the phase http_ratelimit: 2 out of 1"). The slot goes to the read path
// because that is where volume and spend actually are.
//
// What that leaves uncovered is /api/auth/* — the app's unauthenticated
// surface (sign-in, OAuth callbacks, verification), and the one place a
// request does D1 work with no session cookie to short-circuit it. It cannot
// be merged into the rule below: one rule means one threshold, and 5000/10s
// is meaningless for a login flow while auth's ~200/10s would sever nix
// pulls. Covering it needs either a paid plan (more rules in the phase) or a
// worker-level `ratelimits` binding in wrangler.jsonc, which still bills the
// request but keeps the flood off D1 — the same tier DEVICE_AUTH_LIMITER
// already occupies for the device-auth endpoints.
const ratelimitRules = [
	{
		// 5000/10s clears a single honest client's mass-substitution burst:
		// nix runs up to 25 parallel connections against ~30-60ms edge hits
		// (400-800 req/s peak), and edge cache hits still count against this
		// phase. The rule's job is runaway loops and scrapers, not shaping.
		description: 'cache: per-IP read flood backstop (narinfo + NAR paths)',
		expression:
			'(ends_with(http.request.uri.path, ".narinfo") or http.request.uri.path contains "/nar/")',
		action: 'block',
		enabled: true,
		ratelimit: {
			characteristics: ['ip.src', 'cf.colo.id'],
			period: 10,
			requests_per_period: 5000,
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

const hostLabel = hosts.join(' + ');

try {
	const zone = await findZone(cacheHost);
	await Promise.all([
		putPhase(
			zone.id,
			'http_request_firewall_custom',
			`nimbus abuse guards for ${hostLabel} (managed by scripts/deploy-waf.mjs)`,
			customRules
		),
		putPhase(
			zone.id,
			'http_ratelimit',
			`nimbus flood backstops for ${hostLabel} (managed by scripts/deploy-waf.mjs)`,
			ratelimitRules
		)
	]);
	console.log(`deploy-waf: zone ${zone.name} up to date for ${hostLabel}`);
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}
