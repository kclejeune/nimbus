#!/usr/bin/env node
// Fill in the two per-deployment hostnames in wrangler.jsonc: uncomments the
// routes block and sets APP_URL / CACHE_BASE_URL to match. This is the one
// manual step after a Deploy to Cloudflare button clone — run it, commit, and
// push (Workers Builds redeploys; custom domains, DNS, and certificates are
// provisioned on that deploy).
//
// Usage: npm run set-hostnames -- <app-host> <cache-host>
//   e.g. npm run set-hostnames -- app.cache.example.org cache.example.org
//
// Rerunnable: with routes already uncommented it just rewrites the patterns.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [appHost, cacheHost] = process.argv.slice(2);
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function fail(message) {
	console.error(`set-hostnames: ${message}`);
	process.exit(1);
}

if (!appHost || !cacheHost) {
	fail('usage: npm run set-hostnames -- <app-host> <cache-host>');
}
for (const host of [appHost, cacheHost]) {
	if (!HOST_RE.test(host)) fail(`"${host}" is not a bare hostname (no scheme, no path)`);
}
if (appHost === cacheHost) {
	fail('the app and cache hostnames must differ — the worker dispatches by host');
}

const configPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');
let config = readFileSync(configPath, 'utf8');

// Uncomment the routes block if it is still in template form.
if (!/^\s*"routes": \[/m.test(config)) {
	const commented = /^([ \t]*)\/\/ ("routes": \[)\n(?:\1\/\/.*\n)*?\1\/\/ (\],)\n/m;
	const match = config.match(commented);
	if (!match) fail('could not find the routes block (template drifted?)');
	const uncommented = match[0].replace(/^([ \t]*)\/\/ ?/gm, '$1');
	config = config.replace(match[0], uncommented);
}

// Rewrite the two route patterns (first = app, second = cache) and the URLs.
const patternRe = /("pattern": ")[^"]+(", "custom_domain": true)/g;
const found = config.match(patternRe) ?? [];
if (found.length !== 2) fail(`expected 2 route patterns, found ${found.length}`);
const hosts = [appHost, cacheHost];
let routeIndex = 0;
config = config.replace(patternRe, (_, pre, post) => `${pre}${hosts[routeIndex++]}${post}`);

for (const [key, host] of [
	['APP_URL', appHost],
	['CACHE_BASE_URL', cacheHost]
]) {
	const re = new RegExp(`("${key}": ")[^"]+(")`);
	if (!re.test(config)) fail(`could not find ${key} in vars`);
	config = config.replace(re, `$1https://${host}$2`);
}

writeFileSync(configPath, config);
console.log(`set-hostnames: routes + URLs set to ${appHost} (app) and ${cacheHost} (cache)`);
console.log('next: commit and push (Workers Builds redeploys), or run `npm run deploy`');
