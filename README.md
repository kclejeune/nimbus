# nimbus

Nimbus is a serverless, self-hostable Nix binary cache. A Cloudflare Worker (backed by
D1 and R2) serves an [attic](https://github.com/zhaofengli/attic)-compatible
cache with deduplicated storage, closure-aware garbage collection, and a web
dashboard — no servers to run, no idle cost.

```bash
# install the CLI
nix profile install github:kclejeune/nimbus   # or: go install github.com/kclejeune/nimbus/cmd/nimbus@latest

# point it at a nimbus deployment
nimbus login prod https://cache.example.com   # browser locally, device code over SSH

# create a cache, push closures, pull from it
nimbus cache create mycache --public
nimbus push mycache ./result
nimbus use mycache                            # wires up nix.conf (+ netrc if private)
```

Deploying the server is one Worker: `cd web && npm run build && npx wrangler
deploy` — see [Deploy](#deploy). The [CLI](#cli) section covers the full
command set.

![Overview dashboard: storage stats, ingest activity, and garbage collection controls](docs/screenshots/overview.png)

## Motivation

Running a Nix cache shouldn't require running a machine. The excellent
self-hosted options all assume a long-lived server plus a relational database
plus object storage — three things to provision, patch, and pay for while they
sit idle between CI runs. nimbus reimplements the same protocol on
pay-per-request primitives: a Worker for compute, D1 (SQLite) for metadata,
and R2 for NAR/chunk storage (with zero egress fees, which matters for a
binary cache). The storage and database surfaces are deliberately thin — a
portable SQLite schema and a flat object layout — so other serverless
platforms are within reach, but Cloudflare is the deployment target today.

## Standing on attic's shoulders

nimbus is unapologetically an [attic](https://github.com/zhaofengli/attic)
reimplementation, and it exists because attic got the design right: caches as
isolated views into one deduplicated content-addressed store, content-defined
chunking for dedup that survives small rebuilds, JWT-scoped per-cache
permissions, and an HTTP protocol clean enough that a third party can
reimplement it from the source. All of that architecture is attic's, and it
deserves the credit. nimbus speaks the attic protocol on the wire — stock
attic clients work against a nimbus server — and swaps the implementation
underneath for one that fits inside a Worker's constraints.

## Features

- **Attic-compatible protocol** — the full binary-cache surface (narinfo/NAR
  serving with managed Ed25519 signing, `nix-cache-info`, ranges) plus the
  `/_api/v1` API (get-missing-paths, upload-path, cache-config). Existing
  attic clients work unmodified for everything but >100 MB pushes.
- **Multi-tenant caches, global dedup** — public or private caches share one
  content-addressed store; NARs dedup whole and, for uploads ≥ 8 MiB, by
  FastCDC content-defined chunks that dedup individually across caches.
- **Fine-grained access control** — per-user and per-group permission grants
  using attic's bit vocabulary over cache-name patterns (`ci-*`), managed from
  the dashboard (per subject or per cache), with OIDC group-claim sync into
  local groups. Cache creators automatically get full control of what they
  create, grants follow renames, and token minting is bounded by the issuer's
  own effective permissions. New accounts start pending until an admin — or a
  configured OIDC group (`OIDC_ACTIVATION_GROUP`) — activates them.
- **Unified cache endpoint** — the cache-host root doubles as a substituter
  for everything the requester may read: `/<hash>.narinfo` and `/nar/<file>`
  resolve across all public caches (plus private ones the bearer token can
  pull) in priority order, re-signed with a single proxy key. One
  `substituters` line and one `trusted-public-keys` entry cover every cache.
- **Server-side compression** — per-cache zstd (WASM), gzip, or none;
  brotli/xz NARs from older imports remain readable.
- **Upstream awareness** — `get-missing-paths` filters against upstream
  caches (e.g. `cache.nixos.org`) with cached verdicts so already-public paths
  are never pushed, and narinfo/NAR reads pass through to upstreams.
- **Closure-aware GC** — retention keeps *full closures* of fresh objects and
  pinned roots (never a broken closure), with per-cache size budgets, a global
  storage ceiling, pin/unpin with notes, size-triggered eviction after pushes,
  abandoned-upload reaping, and a nightly cron.
- **Admin UI** — cache management with per-cache access lists, store-path
  browsing/search, pin/prune, scoped token issuance with revocation,
  users/groups/grants, user activation, ingest monitoring, and an audit log
  of privileged actions.
- **Flexible auth** — OIDC or Cloudflare Access for the dashboard (with OIDC
  group sync and pending-user approval); HS256/RS256 attic JWTs for the
  protocol; browser-loopback and RFC 8628 device-code flows for CLI login.
- **Go CLI** — `login`, `use`, `push` (parallel, closure-aware, `--stdin`),
  `watch-store`, `watch-exec`, `gc`, and full cache administration.

<table>
  <tr>
    <td><img src="docs/screenshots/cache-detail.png" alt="Cache detail: trust configuration and store path browser"></td>
    <td><img src="docs/screenshots/monitoring.png" alt="Monitoring: storage growth and push activity over time"></td>
  </tr>
</table>

## Comparison with attic

| | attic | nimbus |
| --- | --- | --- |
| Runtime | Rust daemon (`atticd`) on a server you operate | Cloudflare Worker, scales to zero |
| Database | PostgreSQL or SQLite | D1 (SQLite; schema is portable) |
| Storage | S3-compatible or local disk | R2 (zero-egress) |
| Deduplication | whole-NAR + FastCDC chunks | whole-NAR + FastCDC chunks (≥ 8 MiB uploads; larger 2/8/16 MiB boundaries) |
| Compression | server-wide zstd/brotli/xz | per-cache zstd/gzip/none |
| Garbage collection | per-object LRU (can orphan closure members) | closure-aware retention, pins, per-cache budgets, global ceiling |
| Tokens | static JWTs via `atticadm make-token` | dashboard-issued, scoped, revocable (`jti` + hashed storage), bounded by the issuer's grants |
| Access control | per-token JWT permission bits | user/group grants (same bit vocabulary) + OIDC group sync, enforced in the UI and API; per-token bits on the wire |
| Substituter config | one URL + key per cache | per-cache, or one unified endpoint + proxy key for all readable caches |
| CLI auth | paste a token | browser loopback, device code, or paste a token |
| Admin interface | CLI only | web dashboard + CLI |
| NAR downloads | can 307 to presigned S3 URLs | always proxied through the Worker |

### Gaps and differences

Honest accounting of where nimbus trails or diverges from the reference:

- **>100 MB NARs dedup only at NAR granularity.** The Workers request-body
  limit forces a chunked upload transport with client-side zstd, so the server
  can't cut content-defined boundaries; those NARs are stored whole. A
  client-side FastCDC protocol is designed but not yet implemented.
- **Chunk boundaries are self-consistent, not attic's.** nimbus uses larger
  FastCDC parameters (every chunk is an R2 subrequest), so a store migrated
  from attic won't share chunk identities with it.
- **RS256 is verify-only** — the dashboard mints HS256 tokens; attic can also
  sign RS256.
- **No presigned-URL redirect** — every NAR byte proxies through the Worker.
- **No per-path destroy API** (`attic destroy` equivalent); the dashboard's
  prune action covers it interactively.
- **No headless token minting** (`atticadm make-token` equivalent) — tokens
  come from the dashboard.
- **`retention_period` is expressed in days** (`null` = unlimited) rather
  than attic's seconds with a global default.

## CLI

```bash
nimbus login prod https://cache.example.com <token>    # non-interactive: paste a token
nimbus cache create mycache --public --compression zstd
nimbus use mycache                                     # wire up nix.conf (+ netrc if private)
nimbus push mycache ./result /nix/store/...            # closures, parallel, chunked >100MB
nimbus push mycache --stdin < paths.txt                # read paths from stdin
nimbus watch-store mycache                             # push new store paths as they appear
nimbus watch-exec mycache -- nix build ...             # watch during a command, flush on exit
nimbus gc --dry-run                                    # trigger/preview garbage collection
nimbus cache info|configure|rename|pin|unpin|destroy mycache
```

Caches are addressed as `[server:]cache`; the first login becomes the default
server. Config lives at `~/.config/nimbus/config.toml` (XDG respected).

Pushes query the closure via `nix path-info`, skip paths the server already
has (or can fetch from its upstreams), and upload raw NARs for the server to
compress — except >100MB NARs, which are zstd-compressed client-side and
uploaded through the chunked protocol.

## Layout

```
cmd/nimbus/  Go CLI client (cobra + fang)
internal/    CLI internals: config, API client, nix interop, push engine
web/         SvelteKit app: the admin UI and the binary-cache API server (one Worker)
```

The Worker serves two hostnames from one deployment: the admin UI on its app
domain and the Nix binary-cache API on the cache domain, dispatched by host in
`web/worker-entry.ts`.

## Development

CLI:

```bash
mise run check    # lint + test + build (binary at build/nimbus)
```

Web:

```bash
cd web
npm install
npm run check                            # svelte-check
npm test                                 # vitest (pure server logic)
npm run build                            # vite build + Cloudflare adapter
npx wrangler dev --host localhost:8788   # --host defeats the custom-domain Host rewrite
```

Local secrets live in `web/.dev.vars` (gitignored). The attic-table schema and
its migrations are in `web/schema/`; the admin-table (users, groups, grants,
tokens) migrations are drizzle-generated in `web/drizzle/`. Apply both with
`wrangler d1 execute <db> --file=...`.

## Deploy

```bash
cd web && npm run build && npx wrangler deploy
```

Custom domains and the nightly GC cron are declared in `web/wrangler.jsonc` —
domains not listed there are detached on deploy, so keep that file the source
of truth.
