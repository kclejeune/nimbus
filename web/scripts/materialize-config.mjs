#!/usr/bin/env node
// CI shim for per-deployment config: a push-triggered build (Workers Builds)
// clones the repo without the gitignored wrangler.local.jsonc, so deploys
// from the public template would fail on its placeholder values. Setting a
// WRANGLER_LOCAL_CONFIG_B64 build variable (base64 of the file, generated
// with `base64 -i wrangler.local.jsonc | tr -d '\n'`) materializes it before
// any wrangler command runs; the existing --config auto-detection does the
// rest. No-op when the file already exists (local machines) or the variable
// is unset (self-hosters whose values are committed).

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.local.jsonc');
if (!existsSync(path) && process.env.WRANGLER_LOCAL_CONFIG_B64) {
	writeFileSync(path, Buffer.from(process.env.WRANGLER_LOCAL_CONFIG_B64, 'base64'));
	console.log('materialize-config: wrote wrangler.local.jsonc from WRANGLER_LOCAL_CONFIG_B64');
}
