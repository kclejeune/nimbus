# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

nimbus is a serverless, attic-compatible Nix binary cache: one Cloudflare Worker
(D1 + R2) serving both the binary-cache protocol and a SvelteKit admin UI, plus a
Go CLI client. See `README.md` for the feature surface and `docs/deploy.md` for
self-hosting.

## Commands

CLI (repo root, Go 1.26 + mise):

```bash
mise run check                  # lint + test + build (binary at build/nimbus)
mise run lint                   # golangci-lint --fix + prettier on web/
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
npm run deploy                  # migrate → build → wrangler deploy → WAF rules
```

Local dev: secrets in `web/.dev.vars` (gitignored). `wrangler dev` rewrites the
Host to the first configured route, so plain `curl localhost:8788` always lands
in the SvelteKit app. To exercise the **cache API** locally:

```bash
npx wrangler dev --port 8788 --local --local-upstream localhost:8788
```

That makes the worker see host `localhost:8788`, matching `.dev.vars`
`CACHE_BASE_URL=http://localhost:8788`, so `isCacheHost` dispatches to the attic
routes. Local D1 state lives in `web/.wrangler/state/`.

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
- Cache-tag purges only affect the issuing entrypoint's cache, so GC purges via
  the loopback (`CachedStore.purgeTags`).
- The caching pipeline intermittently mints an empty 502 without invoking
  `CachedStore`; read-path code never emits 502, so `forwardToStore` treats that
  status as a caching-layer failure and re-serves uncached.
- The gateway still runs on edge hits, so anything it does per request scales
  with reads against D1's single write primary. The download-touch is the
  pattern to copy: probe a read replica, and share one recency predicate
  (`TOUCH_GRANULARITY_MS`) between probe and UPDATE so a hot NAR costs one
  primary write per window rather than one per GET.

**Server layout** — `web/README.md` maps `src/lib/server/` dir by dir. The names
that don't announce themselves: `cache/proxy.ts` is the unified-endpoint
resolver (not an HTTP proxy), `cache/db.ts` is the attic-side query layer while
`db/` is drizzle over the admin tables, and `cache/platform.ts` holds the
Workers-primitive wrappers (semaphore, R2 retry).

**Two permission layers, don't conflate them.** *Grants* (`permission_grant`)
are user/group rows over a cache name or glob and drive the UI + admin API;
*tokens* are stateless attic JWTs whose bits are bounded at mint time by the
issuer's effective grants and revoked by `jti`. Wire verification stays pure
attic semantics so attic-minted tokens keep working. The global `gc` claim is
deliberately token-only, never a grant.

**Two auth paths, also distinct:** Cloudflare **Access** (`auth/cf-access.ts`,
`Cf-Access-Jwt-Assertion`, `CF_ACCESS_*`, user ids prefixed `cfaccess:`) vs.
Cloudflare **SSO** / Access-for-SaaS (`auth/providers.ts`, better-auth
`genericOAuth`, `CF_SSO_*`). Before debugging an auth bug, establish which one
the deployment has configured — a fix in one does nothing for the other. Only
the primary `OIDC_ISSUER` provider creates users; the rest are link-only.

**CLI** (`cmd/nimbus/` cobra+fang, `internal/` for guts): `internal/push` drives
closure queries via `internal/nix`, and `internal/chunker` implements FastCDC
with boundaries **bit-identical to the server's** (`cache/chunking.ts`) so
client-cut >100MB NARs dedup against server-cut ones. Changing chunker
parameters on one side without the other silently breaks dedup.

**Database.** One D1 database, two migration systems: attic-descended tables in
`web/schema/migrations/` (applied by `npm run migrate` via
`wrangler d1 migrations apply`, lexicographic `YYYY-MM-DD-` order, several are
non-idempotent ALTERs) and admin tables in `web/drizzle/` (drizzle-kit
generated, applied out-of-band with `wrangler d1 execute <db> --remote --file=`).
D1 bills a written row per indexed column per write and writes cost ~1000x
reads, so an index over a hot-write table to save a nightly scan is usually a
net loss — the arithmetic for the one we rejected is at the end of
`web/schema/migrations/2026-07-27-index-cleanup.sql`.

**Tests.** `web/vitest.config.ts` is plain node plus a `$lib` alias — no
SvelteKit plugin, no workerd. Only pure server modules are testable; anything
touching bindings, D1, or R2 has no harness, which is why `store.ts`, `gc.ts`,
and `upload.ts` have none. On the Go side, macOS auto-GC reaps unrooted
`nix store add-path` fixtures mid-run, and the failure reads as a push bug.

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
  — the phase-entrypoint PUT replaces the *entire* phase, so rules added by hand
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
  `worker-entry.ts` and not `hooks.server.ts`, and why compression *policy*
  helpers in `compression/config.ts` stay wasm-free for admin-side imports.
- **Never resolve a promise from another request's I/O context on Workers** —
  the continuation is canceled, the waiter hangs, and the client sees error
  1101. Cross-request coordination (`cache/platform.ts` `Semaphore`) polls a
  shared counter on the waiter's own jittered `setTimeout`.
- **`cacheInfo` URLs come from `CACHE_BASE_URL`, not the request origin.**
  Deriving from the origin poisons `api_endpoint` under `wrangler dev`.
- **Nix interop, from real bugs:** `os.UserConfigDir` is wrong on macOS (returns
  `~/Library/Application Support`; resolve XDG explicitly); `nar_hash` needs SRI
  base64 → `sha256:<hex>` conversion; repeated keys in `nix.conf` *override*
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
