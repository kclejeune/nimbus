# nimbus web

One Cloudflare Worker serving both halves of nimbus, dispatched by host in
`worker-entry.ts`:

- **Admin UI** (SvelteKit) on the app hostname: caches and their access
  lists, store paths, pins, scoped tokens, users/groups/grants, the upstream
  registry, monitoring, GC, settings, and the audit log.
- **Binary-cache API** (attic-compatible) on the cache hostname:
  narinfo/NAR serving with server-managed Ed25519 signing, uploads with
  server-side compression (zstd via WASM, gzip, none; brotli/xz readable),
  the chunked protocol for NARs ≥ 100 MiB, get-missing-paths with upstream
  filtering, cache config, closure-aware GC, CLI device auth, and the
  root-level unified endpoint.

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
- **Tokens**: stateless attic JWTs (HS256) minted from the dashboard/CLI flows,
  bounded at mint time by the issuer's effective access, revocable by `jti`.
  Verification is unchanged attic semantics, so attic-minted tokens work.
  Tracked tokens are suspended while their owner is deactivated and resume on
  reactivation; revocation is permanent. Admins can also mint a
  storage-wide garbage-collection token (the nimbus `gc` claim, which is a
  token scope and never a per-cache grant) for triggering GC from CI or cron.

New accounts start `pending` and see a wall page until an admin activates
them, or automatically when their groups claim contains
`OIDC_ACTIVATION_GROUP`. The first user on a fresh installation becomes an
active admin and the owner (`auth/bootstrap.ts`). That bootstrap edge is
latched permanently so removing every admin cannot promote an arbitrary later
sign-in; recovery requires the explicit database operation documented in
`docs/deploy.md`.

Deleting a user tombstones their token ids in `revoked_token` in the same
batch that removes their `api_token` rows. A `jti` absent from both tables is
treated as an untracked attic/bootstrap token and accepted, so without the
tombstone a deleted user's tokens would work again until their signed expiry.
Nightly GC prunes tombstones once the token has expired; tombstones for
tokens without an expiry are kept.

Manual GC (`POST /_api/v1/gc`) accepts the nimbus `gc` claim, or an
attic-native token with delete on the literal `*` pattern. It never resolves
authority through a cache name, and `gc` is a reserved cache name.

### Authorization freshness

The cache host accepts a bounded staleness window on its high-volume paths.
The window is part of the security model, not a caching side effect:

| State                                                                                                            | Where it is checked                | Maximum staleness                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Token signature and expiry                                                                                       | per-isolate verify memo            | 30 s, never past the token's `exp`                                    |
| `jti` revocation, owner deactivation or deletion — reads, uploads, batch queries                                 | per-isolate memo over a D1 replica | 30 s + replica lag                                                    |
| `jti` revocation, owner deactivation or deletion — every other mutation (token, cache config, pins, destroy, GC) | D1 primary on every call           | none                                                                  |
| Cache row (visibility, keypair) for read authorization and discovery documents                                   | per-isolate memo over a replica    | 30 s + replica lag (the mutating isolate drops its entry immediately) |

Replica lag is platform-dependent and measured separately; the 30-second
figures are the application's own bound and are pinned by fake-timer tests in
`src/lib/server/cache/remediation.test.ts`. The cache-tag purges issued on a
public→private flip or a keypair rotation remove already-cached edge
responses; they supplement the authorization control and do not replace it.
Shortening the window needs a cross-isolate invalidation design with measured
failure behavior. Do not add another cache layer or copy authorization state
into KV without an absolute freshness deadline.

## Chunk staging

Chunk rows are written before the R2 PUT, so the orphan reaper finds
interrupted uploads, and a NAR's new chunks publish in one batch with its
metadata. Identical retries share a pending chunk. A pending row with no
holders, or any pending or GC-claimed row whose hold is over an hour old, is
taken over by the next upload of that chunk, so a killed upload never blocks
a re-push until the nightly GC. Objects already in R2 with no D1 row are not
rediscovered.

## Structure

```
worker-entry.ts         deploy entry: host dispatch, CachedStore edge-cache
                        entrypoint, nightly GC cron
purge-coordinator.ts    Durable Object queueing cache-tag purges and chunk repair
src/lib/server/cache/   binary-cache engine: router (gateway auth, admission),
                        store (edge-cached reads), upload + chunking, GC,
                        proxy (unified-endpoint resolution), upstream registry
                        and pull-through, platform (semaphore, memory budget,
                        R2 retry), db (attic-table queries), compression/
src/lib/server/attic/   protocol pieces: narinfo, Ed25519 signing, JWT verify
src/lib/server/auth/    better-auth providers, Cloudflare Access, grants and
                        permission resolution, group sync, user admin
src/lib/server/db/      drizzle schema and queries for the admin tables
src/lib/server/*.ts     token minting (attic-token), token registry, audit log,
                        Analytics Engine queries (traffic), request-body limits
src/routes/(app)/       admin UI; cli/, login/, pending/ are the unauthenticated pages
schema/                 attic-table schema.sql + deltas for existing databases
drizzle/                admin-table migrations (drizzle-kit generate)
scripts/                deploy helpers: migrate, config materialization, hostnames, WAF
```

## Development

```bash
npm install
npm run check        # formatting, types, tests, build, and preview smoke
npm run check:types  # svelte-check with the TypeScript 7 native checker
npm test             # vitest over pure server modules and cache/test-db.ts (node:sqlite)
npm run test:store-transport  # native workerd streams, including a 15 s stall
npm run test:preview  # build, initialize Node preview, and exercise its routes
npm run build        # vite build + Cloudflare adapter → .svelte-kit/cloudflare
npm run dev:worker   # wrangler dev on localhost:8788
```

`npm run check` is the full web validation task, also used by CI and
`mise run check`. Vitest and type checking run independently of the build;
`test:preview` depends on the build and checks the resulting server in Node.
`check:types` and `check:watch` use `svelte-check --tsgo --incremental` for TypeScript 7
checking, including generated Svelte component types. Incremental mode reuses
unchanged results and removes generated files for deleted components. The `@typescript/native`
npm alias installs TS7 alongside `typescript` 6, which SvelteKit and
`svelte-check` still need for their JavaScript APIs. Keep both dependencies;
replacing the `typescript` package with TS7 breaks those APIs. `check:watch`
keeps watching types only.

`test:store-transport` checks native BYOB reads, partial final batches, Range
headers, truncated bodies, and cancellation without production bindings. Add
`-- --benchmark` to compare guarded and native forwarding of 64 MiB and batched
versus ordinary native collection of an 8 MiB chunk. Large
native bodies use a 64 KiB minimum fill and 128 KiB buffer capacity with a
15-second progress deadline on the internal store transport; downstream
backpressure is excluded from that deadline. Body diagnostics record both
`batchBytes` (minimum fill) and `bufferBytes` (capacity) for production comparisons.

Each store call has its own ten-second cache-header timeout. After a transport
failure, recovery bypasses further cache loopbacks within that request. Internal
metadata is decoded once before release and can retry once as a whole; partially
delivered NAR streams still abort so the client can retry safely. Anonymous
envelope fills reuse fresh tagged membership without renewing its original age.
Upstream configuration is shared through an internal edge snapshot with a
ten-minute TTL and no stale-on-error; registry, subscription, and cache lifecycle
changes purge its tag. Each use consults the edge snapshot, so an isolate memo
cannot hide a completed purge. Replica lag and fills already in flight can still
race a mutation; purges are not atomic with origin fills.

CDC completion can buffer one subsequent chunk body while verifying the current
chunk, using the same shared upload memory budget. Speculative reads take a spare
full slot immediately or fall back to header-only read-ahead. They never queue
for memory, and verification failure cancels unused body reads. Completion timing
logs include `upload.prefetchedChunks` to measure adoption in production.
Read-ahead can occupy the second full slot until consumed, trading upload
concurrency for completion latency within the unchanged 64 MiB byte budget.
Collector reads retain their 30-second idle and ten-minute absolute deadlines.

Security overrides keep Typography's `postcss-selector-parser` and Miniflare's
`undici` on patched releases until their upstream dependency constraints catch up.
The `runed` overrides move the versions used by Bits UI and LayerChart to the
SvelteKit 3 peer dependency; older versions used by other libraries stay unchanged.
SvelteKit 3 uses an explicit `$lib` alias in Vite and TypeScript. The server hook
adapts `cloudflare:workers` bindings to the app's `platform.env`/`platform.ctx`
contract, including the loopback exports used for cache purges.

Better Auth 1.7 uses the social APIs for generic OAuth sign-in and linking.
Register `<APP_URL>/api/auth/callback/oidc` with the primary OIDC provider and
`<APP_URL>/api/auth/callback/cloudflare` with the Cloudflare Access for SaaS app
when that provider is enabled. These are Better Auth's native callback routes.
Cloudflare Access header assertions use a separate authentication path.
Account IDs and the database schema are unchanged; unlink requests now select
the local account row ID. Pending sign-in attempts must be restarted after the
upgrade because the patched OAuth state format changed. See the
[1.7 migration guide](https://better-auth.com/docs/guides/1-7-upgrade-guide).

Copy `.dev.vars.example` to `.dev.vars`, fill in the secrets, and add
`APP_URL=http://localhost:8788`. `dev:worker` presents every request as host
`localhost:8788`; the Worker serves the cache API when that matches
`CACHE_BASE_URL`. Set `CACHE_BASE_URL=http://localhost:8788` in `.dev.vars`
to exercise the cache API and omit it to use the admin UI. `npm run migrate:local` creates or
updates the local D1.

The adapter writes its worker to the `main` of `wrangler.adapter.jsonc`;
`wrangler.jsonc` points `main` at `worker-entry.ts`, which wraps that output.
Keep the two configs separate: the adapter overwrites whatever `main` it
reads.

## Deploy

`npm run deploy` migrates, builds, and deploys. `wrangler.jsonc` is the
manifest (domains, GC cron, bindings, auth vars).
[../docs/deploy.md](../docs/deploy.md) covers configuration, config overlays,
and how `npm run migrate` (`scripts/migrate.mjs`) handles the two schema
sources.
