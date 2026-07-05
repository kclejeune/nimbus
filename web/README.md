# nimbus web

One Cloudflare Worker serving both halves of nimbus:

- **Admin UI** (SvelteKit) — caches, tokens, users, monitoring, retention and
  GC controls. Served on the app hostname (`app.cache.kclj.io`).
- **Binary-cache API** (attic-compatible) — narinfo/NAR serving with managed
  Ed25519 signing, `get-missing-paths` with upstream filtering, closure-aware
  garbage collection. Served on the cache hostname (`cache.kclj.io`), dispatched
  by host in `src/hooks.server.ts` before SvelteKit routing.

The entire protocol runs natively: narinfo/NAR serving, uploads with
server-side compression (zstd via WASM, gzip, none — brotli/xz NARs remain
readable), the chunked >100MB protocol, cache config, and CLI device auth.

## Structure

```
src/lib/server/attic/   binary-cache API: router, narinfo, signing, JWT
                        verification, GC (closure-aware retention, size
                        budgets, gc roots), upstream filtering
src/lib/server/auth/    better-auth (OIDC) + Cloudflare Access fallback
src/lib/server/db/      drizzle schema/queries for admin-owned tables
src/routes/(app)/       admin UI
schema/                 attic-table schema + migrations (wrangler d1 execute)
worker-entry.ts         deploy entry: SvelteKit worker + scheduled GC handler
```

## Development

```bash
npm install
npm run check        # svelte-check
npm run build        # vite build + Cloudflare adapter (writes .svelte-kit/cloudflare)
npx wrangler dev --host localhost:8788   # --host defeats the custom-domain Host rewrite
                                         # (.dev.vars: secrets + CACHE_BASE_URL=http://localhost:8788)
```

The adapter writes its generated worker to the `main` of `wrangler.adapter.jsonc`;
`wrangler.jsonc` (deploy config) points `main` at `worker-entry.ts`, which wraps
that output to add the nightly GC cron. Don't collapse the two configs — the
adapter overwrites whatever `main` points at.

## Deploy

```bash
npm run build && npx wrangler deploy
```

Both custom domains and the GC cron schedule live in `wrangler.jsonc`. Secrets
(`JWT_HS256_SECRET_BASE64`, `SESSION_SECRET`, OIDC credentials) are set with
`wrangler secret put`.
