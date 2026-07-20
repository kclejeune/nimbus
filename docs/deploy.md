# Deploying nimbus

Nimbus runs as a single Cloudflare Worker backed by D1 (metadata) and R2
(NAR/chunk storage). Deploying it into your own Cloudflare account takes one
config file, two resource-creation commands, a handful of secrets, and
`npm run deploy` — or start from the one-click button below.

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kclejeune/nimbus/tree/main/web)

The button clones this repo into your GitHub/GitLab account, provisions the
D1 database and R2 bucket automatically, prompts for the secrets in
`web/.dev.vars.example`, and deploys to a `workers.dev` hostname via Workers
Builds (pushes to your clone redeploy automatically). Then finish in your
cloned repo:

1. Set your two hostnames (writes `routes` + `APP_URL`/`CACHE_BASE_URL` in
   `web/wrangler.jsonc`):

   ```bash
   cd web && npm run set-hostnames -- app.cache.example.org cache.example.org
   ```

2. Configure a sign-in method ([Authentication](#authentication)).
3. Commit and push (or run `npm run deploy`) — custom domains, DNS, and
   certificates are provisioned on deploy.

The rest of this document is the equivalent manual walkthrough.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Cloudflare account, **Workers Paid** ($5/mo) | Free-plan CPU limits (10ms/request) are too small for server-side zstd compression and GC sweeps. Idle cost beyond the subscription is ~zero. |
| A domain on your Cloudflare account | Two hostnames are required for full operation (admin UI + cache API); the worker dispatches by host, so a single `workers.dev` hostname is not enough. A first deploy can land on `workers.dev` before domains are added. DNS records and certificates are provisioned automatically on deploy. |
| Node.js 24+ and npm | For building and deploying. |
| An identity provider | Any OIDC issuer, a GitHub or Google OAuth app, or Cloudflare Access — see [Authentication](#authentication). |

## Configuration

`web/wrangler.jsonc` is the deployment manifest. Two ways to supply your
values:

- **Fork model**: edit `wrangler.jsonc` in place and commit it to your fork.
- **Overlay model**: copy it to `web/wrangler.local.jsonc` (gitignored) and
  put your values there. Every npm deploy script prefers the local file
  automatically, so you can track this repo directly and `git pull` without
  conflicts.

Values to replace:

- `routes` — commented out in the template so a first deploy lands on
  `workers.dev` without a zone; uncomment with your two hostnames (e.g.
  `app.cache.example.com` and `cache.example.com`). Once added, keep them —
  wrangler detaches custom domains missing from the config.
- `vars.APP_URL` / `vars.CACHE_BASE_URL` — the matching URLs.

  `npm run set-hostnames -- <app-host> <cache-host>` writes both of the
  above in one step.
- `vars` for your chosen auth method(s) — see below.
- `d1_databases[0].database_id` — from [Resources](#resources).

## Resources

```bash
cd web
npm install
npx wrangler login

npx wrangler d1 create attic          # paste database_id into your config
npx wrangler r2 bucket create attic-cache
```

Schema migrations are applied automatically by `npm run deploy` (or manually
with `npm run migrate`).

## Authentication

Configure at least one sign-in method. The **first user to sign in becomes
admin and instance owner**; everyone after that starts `pending` until an
admin activates them (or their OIDC groups claim contains
`OIDC_ACTIVATION_GROUP`).

| Method | Vars | Secrets |
| --- | --- | --- |
| Generic OIDC (Authentik, Keycloak, Auth0, …) | `OIDC_ISSUER`, `OIDC_CLIENT_ID` | `OIDC_CLIENT_SECRET` |
| GitHub OAuth app | `GITHUB_CLIENT_ID` | `GITHUB_CLIENT_SECRET` |
| Google OAuth client | `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_SECRET` |
| Cloudflare Access | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | — (validates the Access JWT) |

OAuth callback URLs are `<APP_URL>/api/auth/callback/<provider>`. With OIDC,
`OIDC_GROUPS_CLAIM` (default `groups`) syncs IdP groups to nimbus groups at
login, and membership in `OIDC_ACTIVATION_GROUP` (default `nimbus_user`)
auto-activates new accounts.

## Secrets

```bash
npx wrangler secret put SESSION_SECRET            # e.g. openssl rand -base64 32
npx wrangler secret put JWT_HS256_SECRET_BASE64   # e.g. openssl rand -base64 64 | tr -d '\n'
npx wrangler secret put OIDC_CLIENT_SECRET        # if using OIDC (likewise for
                                                  # GITHUB_/GOOGLE_CLIENT_SECRET)
```

`SESSION_SECRET` signs dashboard session cookies. `JWT_HS256_SECRET_BASE64`
signs attic-compatible cache tokens — treat it like a root credential; anyone
holding it can mint tokens for any cache. `web/.dev.vars.example` lists the
same secrets with generation commands (copy it to `.dev.vars` for local dev).

## Deploy

```bash
npm run deploy   # migrations → build → wrangler deploy (+ optional WAF rules)
```

Then open `https://<APP_URL>`, sign in (you become admin), create a cache,
and point the CLI at it:

```bash
nimbus login prod https://cache.example.com
nimbus cache create mycache
nimbus use mycache
```

## Optional

### Monitoring traffic charts

The monitoring page's traffic/edge-cache/write charts query Workers Analytics
Engine. Set `vars.CF_ACCOUNT_ID` and a `CF_ANALYTICS_TOKEN` secret (API token
with **Account Analytics: Read**). Without them the page simply hides those
sections; metrics are still collected.

### WAF abuse rules

`npm run deploy` finishes with `scripts/deploy-waf.mjs`, which declaratively
applies zone-level WAF rules protecting the cache hostname (query-string
cache-busting block, method restriction, a per-IP read-flood rate limit). It
needs a `WAF_API_TOKEN` env var (API token with **Zone: Read** and **Zone
WAF: Edit**, scoped to your zone) and derives the hostname from your wrangler
config. Without the token it prints a warning and skips — the deploy still
succeeds. [fnox](https://github.com/jdx/fnox) users can define `WAF_API_TOKEN`
in `fnox.local.toml`; the deploy script picks it up automatically when fnox
is installed.

### Cloudflare Access in front of the admin UI

For an additional auth wall, put the app hostname behind Cloudflare Access
and set `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`. Existing accounts are
matched by email, so use the same identity provider in Access as for OIDC
sign-in. Keep the cache hostname *outside* Access — nix clients cannot answer
challenges.

### Push-triggered deploys (Workers Builds)

If your deployment values are committed (the fork model, including Deploy
button clones), connecting the repo to Workers Builds just works — set the
root directory to `web` and pushes deploy automatically.

If you track this repo directly with values in the untracked
`wrangler.local.jsonc`, CI clones won't have that file and the build fails
closed at `migrate` (the template's placeholder D1 id). To enable push
deploys, commit your instance config under its own name (hostnames and
resource ids are not secrets — e.g. `web/wrangler.myname.jsonc`) and add a
build variable `WRANGLER_LOCAL_CONFIG_PATH` set to that filename (relative
to `web/`). `scripts/materialize-config.mjs` (a dependency of every deploy
task) copies it to `wrangler.local.jsonc` before wrangler runs, so config
changes are just commits — nothing to re-sync. Locally, point the
auto-detected name at the same file once:

```bash
cd web && ln -s wrangler.myname.jsonc wrangler.local.jsonc
```

Optionally add a `WAF_API_TOKEN` build secret so the WAF step applies in CI
too; without it the step skips with a warning.

Build settings: root directory `web`, deploy command `npm run deploy`, and
non-production branch deploy command `npm run deploy:preview` — it builds
and runs `wrangler versions upload` with the same config detection, but
deliberately skips D1 migrations (which would mutate the production
database) and the WAF step.

### Pull-through upstreams

Upstream caches (e.g. `cache.nixos.org`) are configured per-cache from the
dashboard, not at deploy time.
