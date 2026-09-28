# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

nimbus is a serverless, attic-compatible Nix binary cache: one Cloudflare Worker
(D1 + R2) serving both the binary-cache protocol and a SvelteKit admin UI, plus a
Go CLI client. See `README.md` for the feature surface and `docs/deploy.md` for
self-hosting.

## Commands

CLI (repo root, Go 1.26 + mise):

```bash
mise run check                  # lint + go test + build CLI and web (binary at build/nimbus)
mise run lint                   # golangci-lint --fix + prettier --write on web/ (rewrites files)
go test ./...                   # all Go tests
go test ./internal/chunker -run TestDifferentialCorpus -v   # one test
go build -o build/nimbus ./cmd/nimbus
nix build .                     # flake package (bump vendorHash when go.mod changes)
```

Web (`cd web`, Node 24, scripts sequenced by wireit):

```bash
npm run check                   # svelte-check
npm test                        # vitest run
npx vitest run src/lib/server/auth/permissions.test.ts   # one test file
npm run lint / npm run format   # prettier
npm run build                   # vite build → .svelte-kit/cloudflare
npm run migrate:local           # create or update the wrangler dev database
npm run deploy                  # migrate + build, then wrangler deploy; WAF rules in parallel
npm run dev:worker              # wrangler dev on :8788, Host forced to localhost:8788
```

Local dev: secrets in `web/.dev.vars` (gitignored). `dev:worker` makes every
request arrive as host `localhost:8788`, so `isCacheHost` sends _all_ traffic to
the attic routes when `.dev.vars` sets `CACHE_BASE_URL=http://localhost:8788`,
and all of it to SvelteKit otherwise — pick one per session. Local D1 state
lives in `web/.wrangler/state/`.

## Architecture

**One Worker, two hostnames.** `web/worker-entry.ts` is the deploy entry: it
compares the request host against `CACHE_BASE_URL` and sends cache-host traffic
to `handleCacheApi` (`src/lib/server/cache/router.ts`), everything else to the
adapter-generated SvelteKit worker. It also owns the nightly GC `scheduled`
handler (which runs `ANALYZE` afterward to keep D1's query planner honest).

**Gateway vs. CachedStore.** The default export always runs — host dispatch and
authorization — with its own cache disabled. Authorized read requests are
forwarded over a `ctx.exports` loopback to the `CachedStore` entrypoint, which
has Workers Caching enabled; on an edge hit `store.ts` never executes and
neither D1 nor R2 is touched. Consequences:

- Nothing in `store.ts` may read `Authorization` or vary by caller.
- Workers Caching strips/handles `Range` itself — never return a 206.
- Cache-tag purges only affect the issuing entrypoint's cache, so every purge
  goes through `CachedStore`: routine GC and uploads via `enqueuePurgeTags`
  (durably queued in the `PurgeCoordinator` Durable Object, which calls back
  into `CachedStore.purgeBatch`), trust mutations and path removal via the
  urgent `purgeTags`.
- The caching pipeline intermittently mints an empty 502 without invoking
  `CachedStore`; read-path code never emits 502, so `viaStore`
  (`cache/metadata.ts`) treats that status as a caching-layer failure and
  re-serves uncached.
- The gateway still runs on edge hits, so anything it does per request scales
  with reads against D1's single write primary. The download-touch is the
  pattern to copy: probe a read replica, and share one recency predicate
  (`TOUCH_GRANULARITY_MS`) between probe and UPDATE so a hot NAR costs one
  primary write per window rather than one per GET.

**Server layout.** `web/README.md` maps `src/lib/server/` dir by dir. The names
that don't announce themselves: `cache/proxy.ts` is the unified-endpoint
resolver (not an HTTP proxy), `cache/db.ts` is the attic-side query layer while
`db/` is drizzle over the admin tables, and `cache/platform.ts` holds the
Workers-primitive wrappers (semaphore, upload `MemoryBudget`, R2 retry).

**Two permission layers, don't conflate them.** _Grants_ (`permission_grant`)
are user/group rows over a cache name or glob and drive the UI + admin API;
_tokens_ are stateless attic JWTs whose bits are bounded at mint time by the
issuer's effective grants and revoked by `jti`. Wire verification stays pure
attic semantics so attic-minted tokens keep working. The global `gc` claim is
token-only by design; never add it as a grant.

**Two auth paths, also distinct.** Cloudflare **Access** (`auth/cf-access.ts`,
`Cf-Access-Jwt-Assertion`, `CF_ACCESS_*`, user ids prefixed `cfaccess:`) vs.
Cloudflare **SSO** / Access-for-SaaS (`auth/providers.ts`, better-auth
`genericOAuth`, `CF_SSO_*`). Before debugging an auth bug, establish which one
the deployment has configured — a fix in one does nothing for the other. Users
are created only by the Access path and the primary `OIDC_ISSUER` provider
(GitHub, Google, and CF SSO are link-only). Both paths call
`auth/bootstrap.ts`, which promotes the signer-in while no admin exists.

**CLI** (`cmd/nimbus/` cobra+fang, `internal/` for guts): `internal/push` drives
closure queries via `internal/nix`, and `internal/chunker` implements FastCDC
with boundaries **bit-identical to the server's** (`cache/chunking.ts`) so
client-cut NARs (≥ 100 MiB) dedup against server-cut ones. Changing chunker
parameters on one side without the other silently breaks dedup.

**Database.** One D1 database, two schema sources, both driven by
`web/scripts/migrate.mjs` (`npm run migrate`): attic-descended tables in
`web/schema/schema.sql` plus deltas in `web/schema/migrations/` (wrangler's
`d1_migrations`, lexicographic `YYYY-MM-DD-` order, several non-idempotent
ALTERs), and admin tables in `web/drizzle/` (drizzle-kit output, tracked in
`admin_migrations`). The deltas do not replay from empty — the first ALTERs a
table only `schema.sql` creates — so an empty database loads `schema.sql` and
records every delta as applied. **A schema change therefore lands in both
`schema.sql` and a new delta**; `cache/schema.test.ts` fails when they
disagree. Production applied the 2026-07 deltas by hand in commit order, not
filename order; keep deltas correct in filename order regardless.
D1 bills a written row per indexed column per write and writes cost ~1000x
reads, so an index over a hot-write table to save a nightly scan is usually a
net loss — the arithmetic for the one we rejected is at the end of
`web/schema/migrations/2026-07-27-index-cleanup.sql`.

**Tests.** `web/vitest.config.ts` is plain node plus a `$lib` alias — no
SvelteKit plugin, no workerd. Only pure server modules are testable; anything
touching bindings runs against `cache/test-db.ts` (node:sqlite over the real
schema, mocked R2/compression — SQL semantics, not D1 replication or workerd);
`runGc` and its passes still have none. On the Go side, macOS auto-GC reaps
unrooted `nix store add-path` fixtures mid-run, and the failure reads as a push
bug.

## Traps

- **`wrangler deploy` detaches custom domains not declared in the config.** This
  already caused a production outage. Both hostnames live in the `routes` block
  — keep them there and keep that file the source of truth.
- **Three wrangler configs, by design.** `wrangler.jsonc` is the de-personalized
  template (placeholders, `routes` commented out) for one-click deploy;
  `wrangler.kclj.jsonc` is the tracked maintainer instance (hostnames and
  resource ids, not secrets); `wrangler.local.jsonc` is a gitignored symlink to
  whichever one applies, preferred automatically by every npm script, with
  `WRANGLER_LOCAL_CONFIG_PATH` (`scripts/materialize-config.mjs`) as the CI
  equivalent. Deploying against the template fails with
  `Invalid property: databaseId`. Only the npm scripts apply that precedence —
  a bare `npx wrangler d1 …`/`deploy` reads the template and fails that way, so
  pass `--config=wrangler.local.jsonc` on every ad-hoc invocation.
- **The zone WAF is declarative desired state in `web/scripts/deploy-waf.mjs`**
  — the phase-entrypoint PUT replaces the _entire_ phase, so rules added by hand
  in the dashboard are erased on the next `npm run deploy:waf`. The Free plan's
  `http_ratelimit` phase holds **exactly one rule** (a second returns
  `50001: exceeded the maximum number of rules`), its expressions expose Path
  but not Host, and only `period=10`/`mitigation_timeout=10` are accepted. New
  rate limiting means displacing the read-path backstop, a paid plan, or a
  worker-level `ratelimits` binding.
- **`@sveltejs/adapter-cloudflare` writes its bundle to the `main` of whatever
  wrangler config it reads** — hence the separate `wrangler.adapter.jsonc` wired
  through `vite.config.ts`. Don't collapse the two configs or the adapter
  overwrites `worker-entry.ts`.
- **`zstd.wasm` only bundles under wrangler, never Vite** (Workers need a
  `CompiledWasm` import). That's why cache-host dispatch lives in
  `worker-entry.ts` and not `hooks.server.ts`, and why compression _policy_
  helpers in `cache/compression/config.ts` stay wasm-free for admin-side imports.
- **Never resolve a promise from another request's I/O context on Workers.**
  The continuation is canceled, the waiter hangs, and the client sees error 1101. Cross-request coordination (`cache/platform.ts` `Semaphore`) polls a
  shared counter on the waiter's own jittered `setTimeout`.
- **`/_api/v1` speaks attic's serde shapes to stock attic clients**
  (`cache-config.ts` `fromAtticOptions`, `cacheInfo`; `router.ts`
  `atticUploadKind`): retention is attic's `{"Period": secs}` / `"Global"` on
  the wire but whole days in D1, keypair is `"Generate"`, and the upload
  `kind` is capitalized only for an `Attic/` User-Agent because released nimbus
  CLIs compare lowercase. `attic-compat.test.ts` pins these; a nimbus-side field
  change that looks harmless can break every stock client decoding it.
- **`cacheInfo` URLs come from `CACHE_BASE_URL`, not the request origin.**
  Deriving from the origin poisons `api_endpoint` under `wrangler dev`.
- **Nix interop, from real bugs:** `os.UserConfigDir` is wrong on macOS (returns
  `~/Library/Application Support`; resolve XDG explicitly); `nar_hash` needs SRI
  base64 → `sha256:<hex>` conversion; repeated keys in `nix.conf` _override_
  rather than append, so `extra-substituters` must be merged onto one line;
  `nix path-info --json` has two shapes across versions.
- The Cloudflare resources still carry attic names on purpose — D1 `attic`, R2
  `attic-cache`. Those are real identifiers, not leftover branding; don't
  "clean them up".

## Production

Live changes against `cache.kclj.io` / `app.cache.kclj.io` (`wrangler deploy`,
`wrangler d1 execute --remote` writes, cache-config PATCHes, D1 MCP writes) are
blocked by the permission classifier on first attempt regardless of phrasing,
and a go-ahead on the parent task does not carry down. Prepare and verify
locally, then name the exact commands and get an explicit in-turn approval.
Read-only prod access (SELECTs, curl) is fine. For schema changes: migrations
before deploy.
