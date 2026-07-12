# nimbus web

One Cloudflare Worker serving both halves of nimbus:

- **Admin UI** (SvelteKit) — caches (with per-cache access management), scoped
  tokens, users/groups/grants with OIDC group sync and pending-user
  activation, monitoring, retention and GC controls, audit log. Served on the
  app hostname (`app.cache.kclj.io`).
- **Binary-cache API** (attic-compatible) — narinfo/NAR serving with managed
  Ed25519 signing, `get-missing-paths` with upstream filtering, closure-aware
  garbage collection, and a root-level unified endpoint that resolves
  narinfo/NAR requests across every cache the bearer may read (re-signed with
  a server-wide proxy key). Served on the cache hostname (`cache.kclj.io`),
  dispatched by host in `worker-entry.ts` before the SvelteKit worker runs.

The entire protocol runs natively: narinfo/NAR serving, uploads with
server-side compression (zstd via WASM, gzip, none — brotli/xz NARs remain
readable), the chunked >100MB protocol, cache config, and CLI device auth.

## Authorization model

Permissions use attic's per-cache bit vocabulary (`r/w/d/cc/cr/cq/cd`, plus a
nimbus-only global `gc`) at two layers:

- **Grants** (`permission_grant`): user- or group-scoped rows over a cache
  name, glob pattern, or `*`. A user's effective access is the union of their
  direct grants and their groups' grants; admins bypass. OIDC group claims
  (`OIDC_GROUPS_CLAIM`) sync membership into mapped local groups at login;
  manual memberships are never touched by sync. Cache creators automatically
  receive a full-control grant; exact-name grants follow renames and are
  removed on destroy.
- **Tokens**: stateless attic JWTs minted from the dashboard/CLI flows,
  bounded at mint time by the issuer's effective access, revocable by `jti`.
  Verification is unchanged attic semantics, so attic-minted tokens work.
  Tracked tokens are suspended while their owner is deactivated and resume on
  reactivation; revocation is permanent. Admins can additionally mint a
  storage-wide garbage-collection token (the nimbus `gc` claim; deliberately
  a token scope, never a per-cache grant) for triggering GC from CI or cron.

New accounts start `pending` and see a wall page until an admin activates
them, or automatically when their groups claim contains
`OIDC_ACTIVATION_GROUP`.

## Structure

```
src/lib/server/cache/   binary-cache engine: router (gateway auth), edge-cached
                        store, uploads, GC (closure-aware retention, size
                        budgets, gc roots), root-proxy resolution, upstreams
src/lib/server/attic/   protocol pieces: narinfo rendering, Ed25519 signing,
                        attic JWT mint/verify
src/lib/server/auth/    better-auth (OIDC) + Cloudflare Access, groups + grant
                        resolution, guards, user activation
src/lib/server/db/      drizzle schema/queries for admin-owned tables
src/routes/(app)/       admin UI
schema/                 attic-table schema + migrations (wrangler d1 execute)
drizzle/                admin-table migrations (drizzle-kit generate)
worker-entry.ts         deploy entry: host dispatch, CachedStore edge-cache
                        entrypoint, scheduled GC handler
```

## Development

```bash
npm install
npm run check        # svelte-check
npm test             # vitest: permissions, group sync, token/JWT, proxy resolution
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

Both custom domains and the GC cron schedule live in `wrangler.jsonc`, along
with the group-sync/activation vars (`OIDC_GROUPS_CLAIM`,
`OIDC_ACTIVATION_GROUP`). Secrets (`JWT_HS256_SECRET_BASE64`,
`SESSION_SECRET`, OIDC credentials) are set with `wrangler secret put`.

Migrations are applied out-of-band with `wrangler d1 execute <db> --remote
--file=...`: attic tables from `schema/migrations/`, admin tables from
`drizzle/`.
