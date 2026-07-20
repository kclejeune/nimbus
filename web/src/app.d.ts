// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { D1Database, R2Bucket, RateLimit } from '@cloudflare/workers-types';
import type { SessionUser } from '$lib/server/auth/types';
import type { EffectiveAccess } from '$lib/server/auth/permissions';

declare global {
	namespace App {
		// interface Error {}

		interface Locals {
			/** The authenticated user, or null for anonymous requests. */
			user: SessionUser | null;
			/** Memoized per-request effective access (see guard.ts). */
			effectiveAccess?: EffectiveAccess;
		}

		// interface PageData {}
		// interface PageState {}

		interface Platform {
			env: {
				ATTIC_DB: D1Database;
				CACHE_BUCKET: R2Bucket;
				APP_URL?: string;
				CACHE_BASE_URL?: string;
				JWT_HS256_SECRET_BASE64?: string;
				/** Base64 SPKI public key (PEM or DER) for verifying RS256 tokens. */
				JWT_RS256_PUBKEY_BASE64?: string;
				JWT_BOUND_ISSUER?: string;
				JWT_BOUND_AUDIENCES?: string;
				SESSION_SECRET?: string;
				OIDC_ISSUER?: string;
				OIDC_CLIENT_ID?: string;
				OIDC_CLIENT_SECRET?: string;
				GITHUB_CLIENT_ID?: string;
				GITHUB_CLIENT_SECRET?: string;
				GOOGLE_CLIENT_ID?: string;
				GOOGLE_CLIENT_SECRET?: string;
				/** Access for SaaS OIDC app (Cloudflare SSO sign-in/linking). */
				CF_SSO_CLIENT_ID?: string;
				CF_SSO_CLIENT_SECRET?: string;
				CF_ACCESS_TEAM_DOMAIN?: string;
				CF_ACCESS_AUD?: string;
				/** OIDC ID-token claim carrying group names; enables group sync when set. */
				OIDC_GROUPS_CLAIM?: string;
				/** Groups-claim value that auto-activates pending users at login. */
				OIDC_ACTIVATION_GROUP?: string;
				/** Reference prefetch on cold narinfo serves: unset/0 = off; any
				 * positive value warms direct references (one level — prefetched
				 * serves never prefetch further). */
				PREFETCH_DEPTH?: string;
				/** Prefetch loopbacks per isolate per minute (default 240) — the
				 * fallback budget when PREFETCH_LIMITER is not bound. */
				PREFETCH_BUDGET?: string;
				/** Colo-wide prefetch fan-out limiter (wrangler.jsonc ratelimits). */
				PREFETCH_LIMITER?: RateLimit;
				/** Colo-wide backstop for the unauthenticated CLI device-auth
				 * endpoints (the only anonymous D1-primary writes). */
				DEVICE_AUTH_LIMITER?: RateLimit;
				/** Per-IP budget for live upstream fetches on edge-missed reads
				 * (missing-paths.ts); unbound = unguarded. */
				UPSTREAM_PROBE_LIMITER?: RateLimit;
				/** Colo-wide cap on read-path absent-verdict primary writes. */
				ABSENT_VERDICT_LIMITER?: RateLimit;
				/** Colo-wide cap on pull-through ingests (pullthrough.ts). */
				INGEST_LIMITER?: RateLimit;
				/** Analytics Engine dataset for read-path traffic metrics
				 * (narinfo/NAR hit/miss/upstream); unbound = metrics off. */
				CACHE_METRICS?: AnalyticsEngineDataset;
				/** Account id + API token (Account Analytics read) for querying
				 * CACHE_METRICS from the dashboard via the Analytics Engine SQL
				 * API; the monitoring traffic section hides when either is unset. */
				CF_ACCOUNT_ID?: string;
				CF_ANALYTICS_TOKEN?: string;
			};
			ctx: ExecutionContext;
		}
	}
}

export {};
