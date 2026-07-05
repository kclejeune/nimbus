# nimbus

Self-hostable Nix binary cache built on Cloudflare Workers, D1, and R2 — with
multi-tenant caches, closure-aware garbage collection, and a first-class admin
UI. The cache protocol is [attic](https://github.com/zhaofengli/attic)-compatible,
so existing attic clients work today.

## Layout

```
cmd/nimbus/  Go CLI client (cobra + fang)
internal/    CLI internals: config, API client, nix interop, push engine
web/         SvelteKit app: the admin UI and the binary-cache API server (one Worker)
```

The Worker serves two hostnames from one deployment: the admin UI on its app
domain and the Nix binary-cache API on the cache domain, dispatched by host in
`web/worker-entry.ts`.

## CLI

```bash
go install github.com/kclejeune/nimbus/cmd/nimbus@latest

nimbus login prod https://cache.example.com            # browser locally, device code over SSH
nimbus login prod https://cache.example.com <token>    # or paste a token
nimbus cache create mycache --public --compression zstd
nimbus use mycache                                     # wire up nix.conf (+ netrc if private)
nimbus push mycache ./result /nix/store/...            # closures, parallel, chunked >100MB
nimbus watch-store mycache                             # push new store paths as they appear
nimbus cache info|configure|rename|destroy mycache
```

Caches are addressed as `[server:]cache`; the first login becomes the default
server. Config lives at `~/.config/nimbus/config.toml` (XDG respected).

Pushes query the closure via `nix path-info`, skip paths the server already
has (or can fetch from its upstreams), and upload raw NARs for the server to
compress — except >100MB NARs, which are zstd-compressed client-side and
uploaded through the chunked protocol.

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
npm run build                            # vite build + Cloudflare adapter
npx wrangler dev --host localhost:8788   # --host defeats the custom-domain Host rewrite
```

Local secrets live in `web/.dev.vars` (gitignored). The attic-table schema and
its migrations are in `web/schema/`; apply with
`wrangler d1 execute <db> --file=schema/schema.sql`.

## Deploy

```bash
cd web && npm run build && npx wrangler deploy
```

Custom domains and the nightly GC cron are declared in `web/wrangler.jsonc` —
domains not listed there are detached on deploy, so keep that file the source
of truth.
