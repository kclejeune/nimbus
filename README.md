# nimbus

Self-hostable Nix binary cache built on Cloudflare Workers, D1, and R2 — with
multi-tenant caches, closure-aware garbage collection, and a first-class admin
UI. The cache protocol is [attic](https://github.com/zhaofengli/attic)-compatible,
so existing attic clients work today.

## Layout

```
web/   SvelteKit app: the admin UI and the binary-cache API server (one Worker)
cli/   (planned) dedicated CLI client
```

The Worker serves two hostnames from one deployment: the admin UI on its app
domain and the Nix binary-cache API on the cache domain, dispatched by host in
`web/src/hooks.server.ts`.

## Development

```bash
cd web
npm install
npm run check   # svelte-check
npm run build   # vite build + Cloudflare adapter
npx wrangler dev
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
