# Deploying nimbus

nimbus runs as one Cloudflare Worker backed by D1 (metadata) and R2 (NAR and
chunk storage). A deployment needs one config file, two resources, a few
secrets, and `npm run deploy`.

## Prerequisites

| Requirement                         | Notes                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare **Workers Paid** ($5/mo) | Required (see below); idle cost beyond the subscription is ~zero.                                                                                 |
| A zone on your Cloudflare account   | Two hostnames, one for the admin UI and one for the cache API. The Worker dispatches by host, so `workers.dev` alone is not a working deployment. |
| Node.js 24+ and npm                 | Build and deploy tooling.                                                                                                                         |
| An identity provider                | An OIDC issuer or Cloudflare Access; see [Authentication](#authentication).                                                                       |

The Free plan does not work. The config sets `limits.cpu_ms: 300000`, which
Free rejects; Free's 10 ms CPU cap cannot run zstd compression or GC sweeps;
and serving a chunked NAR costs one R2 subrequest per chunk against Paid's
10,000-per-invocation budget (Free allows 50).

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kclejeune/nimbus/tree/main/web)

The button clones this repo into your GitHub/GitLab account, provisions the
D1 database and R2 bucket, prompts for the secrets in
`web/.dev.vars.example`, and deploys to a `workers.dev` hostname through
Workers Builds (pushes to the clone redeploy). Finish in the clone:

1. Set your two hostnames (rewrites `routes`, `APP_URL`, and
   `CACHE_BASE_URL` in `web/wrangler.jsonc`):

   ```bash
   cd web && npm run set-hostnames -- app.cache.example.com cache.example.com
   ```

2. Configure a sign-in method ([Authentication](#authentication)).
3. Commit and push, or run `npm run deploy`. Custom domains, DNS records, and
   certificates are provisioned on deploy, and the deploy initializes the
   database, so sign in only after it finishes.
4. Continue with [After the first deploy](#after-the-first-deploy).

## Manual deploy

The steps below are the manual equivalent of the button.

### Resources

```bash
cd web
npm install
npx wrangler login

npx wrangler d1 create attic          # paste database_id into your config
npx wrangler r2 bucket create attic-cache
```

The binding names (`ATTIC_DB`, `CACHE_BUCKET`) are fixed; the resource names
are yours to choose as long as the config matches.

### Configuration

`web/wrangler.jsonc` is the deployment manifest. Supply your values one of
two ways:

- **Fork**: edit `wrangler.jsonc` and commit it to your fork.
- **Overlay**: copy it to `web/wrangler.local.jsonc` (gitignored) and edit
  the copy, so you can track this repo and `git pull` without conflicts.
  The npm scripts prefer the local file automatically; a bare
  `npx wrangler …` does not, so pass `--config=wrangler.local.jsonc` to
  every ad-hoc invocation.

Values to replace:

- `routes`: commented out so a first deploy can land on `workers.dev`
  without a zone. Uncomment with both hostnames (e.g.
  `app.cache.example.com` and `cache.example.com`) and keep them there:
  `wrangler deploy` detaches custom domains that the config does not list.
- `vars.APP_URL` / `vars.CACHE_BASE_URL`: the matching `https://` URLs.
  `npm run set-hostnames -- <app-host> <cache-host>` writes these and
  `routes` in one step, but always edits `wrangler.jsonc`; overlay users
  edit their local file by hand.
- `vars` for your sign-in method(s); see [Authentication](#authentication).
- `d1_databases[0].database_id`: from [Resources](#resources).

For a private deployment, also set `"workers_dev": false` and
`"preview_urls": false` so nothing reaches the Worker except through your
hostnames (and therefore through Access and the WAF, if configured).

### Authentication

Configure at least one sign-in method that can **create** accounts:

| Method                                       | Creates users | Vars                                        | Secrets                | Callback URL                                    |
| -------------------------------------------- | ------------- | ------------------------------------------- | ---------------------- | ----------------------------------------------- |
| Generic OIDC (Authentik, Keycloak, Auth0, …) | yes           | `OIDC_ISSUER`, `OIDC_CLIENT_ID`             | `OIDC_CLIENT_SECRET`   | `<APP_URL>/api/auth/oauth2/callback/oidc`       |
| Cloudflare Access (header assertion)         | yes           | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`    | —                      | —                                               |
| GitHub OAuth app                             | link only     | `GITHUB_CLIENT_ID`                          | `GITHUB_CLIENT_SECRET` | `<APP_URL>/api/auth/callback/github`            |
| Google OAuth client                          | link only     | `GOOGLE_CLIENT_ID`                          | `GOOGLE_CLIENT_SECRET` | `<APP_URL>/api/auth/callback/google`            |
| Cloudflare SSO (Access for SaaS, OIDC)       | link only     | `CF_SSO_CLIENT_ID`, `CF_ACCESS_TEAM_DOMAIN` | `CF_SSO_CLIENT_SECRET` | `<APP_URL>/api/auth/oauth2/callback/cloudflare` |

Link-only providers sign in accounts that already exist and have linked
that provider from the **Account** page. Admins can also pre-provision an
account by email under **Users**; it takes the assigned role on first
sign-in.

New accounts start `pending` until an admin activates them. Set
`OIDC_GROUPS_CLAIM` (the template uses `groups`) to sync IdP groups into
mapped nimbus groups at every OIDC or Access login, and
`OIDC_ACTIVATION_GROUP` (template: `nimbus_user`) to activate members of that
group automatically. Both are off when unset. Setting the claim also
requests the `groups` OAuth scope, which some IdPs reject; clear it if
sign-in fails with a scope error.

To put the admin UI behind Cloudflare Access, see
[Cloudflare Access in front of the admin UI](#cloudflare-access-in-front-of-the-admin-ui).

### Secrets

```bash
npx wrangler secret put SESSION_SECRET            # openssl rand -base64 32
npx wrangler secret put JWT_HS256_SECRET_BASE64   # openssl rand -base64 64 | tr -d '\n'
npx wrangler secret put OIDC_CLIENT_SECRET        # plus any other provider secrets
```

`SESSION_SECRET` signs dashboard session cookies. `JWT_HS256_SECRET_BASE64`
signs and verifies the attic-compatible cache tokens. Anyone holding it can
mint a token for any cache, so treat it as a root credential.

To keep accepting tokens from an existing attic server, reuse its HS256
secret; for an RS256 attic server also set `JWT_RS256_PUBKEY_BASE64` (nimbus
verifies RS256 but mints only HS256). `JWT_BOUND_ISSUER` and
`JWT_BOUND_AUDIENCES` (comma-separated) enforce `iss`/`aud` like attic's
`token-bound-*` settings.

`web/.dev.vars.example` lists the secrets with generation commands.

### Deploy

```bash
npm run deploy   # migrate + build, then wrangler deploy; WAF rules in parallel
```

## After the first deploy

Open your `APP_URL` and sign in. The first user to sign in, by any method,
becomes the active admin and instance owner. Whenever no admin exists (say,
after a manual database edit), the next user to sign in is promoted the same
way.

A fresh database has no upstreams. Add `https://cache.nixos.org` (key
`cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=`) under
**Upstreams**; until then, pushes upload paths that cache.nixos.org already
serves.

Then point the CLI at the cache host:

```bash
nimbus login prod https://cache.example.com
nimbus cache create mycache
nimbus use mycache
```

## Database migrations

The D1 database holds two sets of tables: the attic-descended cache tables
(`web/schema/schema.sql`, with deltas in `web/schema/migrations/` tracked by
wrangler in `d1_migrations`) and the admin tables (users, groups, grants,
tokens; drizzle-generated in `web/drizzle/`, tracked in `admin_migrations`).
`npm run migrate`, which `npm run deploy` runs first, handles both:

- An empty database gets the current `schema.sql`, every drizzle file, and
  every existing delta recorded as applied.
- An existing database gets whatever deltas and drizzle files it lacks.
  Drizzle files applied by hand before `admin_migrations` existed are
  detected by their tables, indexes, and columns and recorded as applied.

`npm run migrate:local` does the same for the `wrangler dev` database.

## Upgrade notes

### v0.6.1: chunk possession receipts

From v0.6.1 on, chunked uploads (NARs ≥ 100 MiB) require cache-bound
possession receipts, and the protocol does not negotiate: a pre-0.6.1 CLI
cannot finish a chunked upload against a newer Worker, nor the reverse.
Downloads and whole-NAR uploads are unaffected.

1. Apply `2026-09-07-chunk-repair.sql` before the new Worker goes live;
   `npm run deploy` already orders it that way.
2. Deploy the Worker, then upgrade every CLI before resuming large pushes.
   Avoid gradual rollouts that mix old and new Workers while chunked uploads
   are running.

Do not relax receipt verification for old clients: knowing a private chunk's
hash must not let another cache claim its bytes.

## Optional

### Monitoring

The monitoring page's traffic, edge-cache, and write charts query Workers
Analytics Engine (dataset `nimbus_cache_metrics`). Set `vars.CF_ACCOUNT_ID`
and a `CF_ANALYTICS_TOKEN` secret (API token with **Account Analytics:
Read**). Without them those sections are hidden, but metrics are still
recorded.

Read and guard metrics are sampled 1-in-`CACHE_METRICS_SAMPLE` (100) with
weights, traces at 25%; automatic invocation logs are off and application
logs are unsampled. Lower `CACHE_METRICS_SAMPLE` temporarily to investigate
sparse traffic.

### WAF rules

`npm run deploy` also runs `scripts/deploy-waf.mjs`, which writes the zone's
custom-rule and rate-limit phases from your configured hostnames:

- Cache host: block anything outside the binary-cache and `/_api/` path
  shapes, query strings outside `/_api/` (edge-cache busting), writes
  outside `/_api/`, unexpected methods, very long paths, and bot traffic.
- App host: block scanner paths and malformed requests.
- Both hosts: block requests from the countries in `BLOCKED_COUNTRIES`
  (`CN`, `RU`; edit the list, or empty it, for your deployment).
- Rate limit: 5000 `.narinfo`/`/nar/` requests per 10 s per IP and colo.

The script **owns both phases for the whole zone**: every run replaces all
custom and rate-limit WAF rules on it, including ones added in the dashboard
or used by other sites on the zone. Don't enable it on a shared zone without
first moving those rules into the script.

It needs `WAF_API_TOKEN` (**Zone: Read** and **Zone WAF: Edit** on your zone).
Without it the step prints a warning and the deploy still succeeds.
`node scripts/deploy-waf.mjs --dry-run` prints the rules without applying
them. [fnox](https://github.com/jdx/fnox) users can define the token in
`fnox.local.toml`.

### Cloudflare Access in front of the admin UI

Put the app hostname behind an Access application and set
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`. Accounts are matched by email,
so use the same identity provider in Access as for OIDC. Keep the cache
hostname **outside** Access: Nix clients cannot answer its challenges.

### Push-triggered deploys (Workers Builds)

With committed deployment values (a fork, or a Deploy-button clone), connect
the repo to Workers Builds with root directory `web`, deploy command
`npm run deploy`, and non-production deploy command `npm run deploy:preview`
(`wrangler versions upload`, skipping D1 migrations and WAF).

If you track this repo with an untracked `wrangler.local.jsonc`, CI has no
config and the build fails at `migrate` on the template's placeholder
database id. Commit your instance config under its own name (hostnames and
resource ids are not secrets), e.g. `web/wrangler.myname.jsonc`, and set the
build variable `WRANGLER_LOCAL_CONFIG_PATH=wrangler.myname.jsonc`;
`scripts/materialize-config.mjs` copies it into place before wrangler runs.
Locally, symlink the same file:

```bash
cd web && ln -s wrangler.myname.jsonc wrangler.local.jsonc
```

Add `WAF_API_TOKEN` as a build secret to apply WAF rules from CI.

### Reference prefetch

Set `PREFETCH_DEPTH` (> 0) to warm the edge cache with the references of
fetched narinfos. The `PREFETCH_LIMITER` binding caps the extra reads; without
it, `PREFETCH_BUDGET` (default 240) caps them per isolate per minute. Off by
default.

## Cost and overload controls

### Rate limits

The `ratelimits` bindings in the config are admission budgets for the
expensive paths: cold D1 lookups, batch existence queries (one unit per
request plus one per 1000 hashes), upstream fetches, verdict writes, uploads,
storage writes (one unit per started MiB actually written; deduplicated
chunks are free), and the control plane. Budgets that legitimate bursts can
reach (backend reads, batch queries, upstream probes) are keyed per client IP
as well as per colo, so one flooding address does not starve its neighbours.

Refusals are retryable: read-path admission returns an uncacheable 503 with
`Retry-After`, and control-plane limits return 429. On the push preflight a
refused upstream probe degrades instead: unprobed paths are reported missing
and the client uploads slightly more. Refused verdict writes and ingestion
are skipped rather than failed. Binding errors fail closed; an omitted
binding is unlimited, which is what local development uses.

These are eventually consistent rate limits, **not a byte or billing quota**.
A distributed flood multiplies them across colos, refused and edge-served
requests still cost money, and retention byte targets are enforced by GC,
not at upload. A hard spend ceiling needs globally coordinated reservations,
which nimbus does not implement.

### Upload memory

Each isolate admits NAR-carrying requests against a 64 MiB budget with at
most 8 concurrent holders. A body with a declared length up to 15 MiB is
charged `2 × length + 1 MiB`; chunk PUTs and streamed or larger bodies take a
32 MiB slot. Up to 64 requests queue, for at most 5 s (30 s for path uploads
with no `Content-Length`, which is how the stock attic client sends them),
after which they get a 503 with `Retry-After: 5`. CDC manifest calls are not gated, and pull-through
ingestion never queues; it runs only when a slot is free. Body reads have a
30 s idle deadline and a 30 min absolute backstop (the CLI's request timeout).
Pull-through ingestion is limited to NARs up to 16 MiB decompressed; larger
upstream NARs stay available by redirect.

### Oversized objects

Workers Paid keeps the zone's 512 MB cacheable-object limit. Larger
multi-chunk NARs are edge-cached per chunk, but the assembled response still
runs the store and its metadata lookup; legacy oversized single-object NARs
stream from R2.
