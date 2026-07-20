#!/usr/bin/env node
// CI shim for per-deployment config: a push-triggered build (Workers Builds)
// clones the repo without the gitignored wrangler.local.jsonc, so deploys
// from the public template would fail on its placeholder values. Setting a
// WRANGLER_LOCAL_CONFIG_PATH build variable (path relative to web/, e.g.
// wrangler.kclj.jsonc) copies that committed file to wrangler.local.jsonc
// before any wrangler command runs; the existing --config auto-detection
// does the rest. No-op when the file already exists (local machines keep a
// symlink) or the variable is unset (self-hosters whose wrangler.jsonc holds
// their values).

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(webDir, 'wrangler.local.jsonc');
const sourceName = process.env.WRANGLER_LOCAL_CONFIG_PATH;

if (existsSync(target)) {
	console.log('materialize-config: wrangler.local.jsonc already present');
} else if (sourceName) {
	const source = join(webDir, sourceName);
	if (!existsSync(source)) {
		console.error(
			`materialize-config: WRANGLER_LOCAL_CONFIG_PATH points at ${sourceName}, which does not exist`
		);
		process.exit(1);
	}
	copyFileSync(source, target);
	console.log(`materialize-config: copied ${sourceName} to wrangler.local.jsonc`);
} else {
	console.log(
		'materialize-config: no wrangler.local.jsonc and WRANGLER_LOCAL_CONFIG_PATH unset — wrangler will use the tracked wrangler.jsonc'
	);
}
