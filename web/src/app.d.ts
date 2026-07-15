// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
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
				/** Prefetch loopbacks allowed per isolate per minute (default 240). */
				PREFETCH_BUDGET?: string;
			};
			ctx: ExecutionContext;
		}
	}
}

export {};
