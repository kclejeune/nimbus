import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { eq, or, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db';
import { base64urlDecode } from '$lib/server/attic/token';
import { syncGroupsAndMaybeActivate } from './group-sync';
import { isActiveUser, type SessionUser, type UserRole, type UserStatus } from './types';

type Env = App.Platform['env'];

/** How CF-Access-provisioned user ids are formed from the Access subject. */
export const CF_ACCESS_ID_PREFIX = 'cfaccess:';

export function isCfAccessId(userId: string): boolean {
	return userId.startsWith(CF_ACCESS_ID_PREFIX);
}

// Cache one JWKS resolver per team domain across requests.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

const SESSION_COOKIE = 'nimbus-cf-session';
const SESSION_TTL_SECONDS = 15 * 60; // 15 minutes

// Imported per isolate: SESSION_SECRET is stable, and the key import would
// otherwise be the dominant cost of the cookie fast path.
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function importHmacKey(secret: string): Promise<CryptoKey> {
	let key = hmacKeys.get(secret);
	if (!key) {
		key = crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		);
		hmacKeys.set(secret, key);
		key.catch(() => hmacKeys.delete(secret));
	}
	return key;
}

function b64url(buf: ArrayBuffer): string {
	let str = '';
	for (const b of new Uint8Array(buf)) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// JSON so fields (including ids containing colons) never need delimiter
// gymnastics; the payload is HMAC-signed opaque data with no format constraint.
interface SessionCookiePayload {
	id: string;
	role: UserRole;
	exp: number;
}

async function mintSessionToken(userId: string, role: UserRole, secret: string): Promise<string> {
	const payload = JSON.stringify({
		id: userId,
		role,
		exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
	} satisfies SessionCookiePayload);
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return `${b64url(new TextEncoder().encode(payload).buffer as ArrayBuffer)}.${b64url(sig)}`;
}

async function verifySessionToken(
	value: string,
	secret: string
): Promise<Pick<SessionUser, 'id' | 'role'> | null> {
	const dotIdx = value.lastIndexOf('.');
	if (dotIdx === -1) return null;
	const payloadB64 = value.slice(0, dotIdx);
	const sigB64 = value.slice(dotIdx + 1);

	let payloadBytes: Uint8Array;
	let sigBytes: Uint8Array;
	try {
		payloadBytes = base64urlDecode(payloadB64);
		sigBytes = base64urlDecode(sigB64);
	} catch {
		return null;
	}

	const key = await importHmacKey(secret);
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		sigBytes as BufferSource,
		payloadBytes as BufferSource
	);
	if (!valid) return null;

	let payload: SessionCookiePayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return null;
	}
	if (typeof payload.id !== 'string' || !payload.id) return null;
	if (payload.role !== 'admin' && payload.role !== 'member') return null;
	if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) > payload.exp) return null;

	return { id: payload.id, role: payload.role };
}

/**
 * If the request carries a valid Cloudflare Access assertion, return the
 * corresponding user (creating one on first sight). Returns null when Access is
 * not configured or the assertion is absent/invalid.
 *
 * A short-lived HMAC-signed session cookie (nimbus-cf-session, 15 min TTL) is
 * minted after the first successful D1 resolution and verified on subsequent
 * requests, avoiding the 3-4 D1 queries per request for returning users. The
 * CF Access JWT is still validated on every request; the cookie only replaces
 * the D1 user lookup.
 */
export async function resolveCfAccessUser(
	event: RequestEvent,
	env: Env
): Promise<SessionUser | null> {
	const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
	const aud = env.CF_ACCESS_AUD;
	if (!teamDomain || !aud) return null;

	const accessToken =
		event.request.headers.get('Cf-Access-Jwt-Assertion') ?? event.cookies.get('CF_Authorization');
	if (!accessToken) return null;

	let payload: JWTPayload & { email?: string; name?: string };
	try {
		const result = await jwtVerify(accessToken, getJwks(teamDomain), {
			issuer: teamDomain.replace(/\/$/, ''),
			audience: aud
		});
		payload = result.payload;
	} catch {
		return null;
	}

	const sub = payload.sub;
	const email = payload.email ?? null;
	if (!sub) return null;

	// Check session cookie before hitting D1. The cookie is only ever minted
	// for active users (below), so status is implied — a deactivation takes at
	// most the cookie TTL (15 min) to bite on this path.
	const sessionSecret = env.SESSION_SECRET;
	if (sessionSecret) {
		const cookieValue = event.cookies.get(SESSION_COOKIE);
		if (cookieValue) {
			const cached = await verifySessionToken(cookieValue, sessionSecret);
			if (cached) {
				return {
					id: cached.id,
					sub,
					provider: 'cf-access',
					email,
					name: payload.name ?? email,
					role: cached.role,
					status: 'active'
				};
			}
		}
	}

	// Full D1 resolution (first visit or expired/invalid cookie).
	const user = await upsertAccessUser(env, { sub, email, name: payload.name ?? email });

	// Access can forward IdP groups as a custom claim; the shared orchestration
	// skips sync when the claim is absent so an Access JWT without it never
	// wipes memberships. Sync failures must not block login.
	if (env.OIDC_GROUPS_CLAIM) {
		const activated = await syncGroupsAndMaybeActivate(
			env.ATTIC_DB,
			user.id,
			payload as Record<string, unknown>,
			{ groupsClaim: env.OIDC_GROUPS_CLAIM, activationGroup: env.OIDC_ACTIVATION_GROUP }
		).catch((e) => {
			console.warn(`cf-access group sync failed: ${e}`);
			return false;
		});
		if (activated) user.status = 'active';
	}

	// Mint a fresh session cookie to skip D1 on subsequent requests. Pending
	// users get no cookie: the cookie fast path implies active status.
	if (sessionSecret && isActiveUser(user)) {
		const cookieToken = await mintSessionToken(user.id, user.role, sessionSecret);
		event.cookies.set(SESSION_COOKIE, cookieToken, {
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/',
			maxAge: SESSION_TTL_SECONDS
		});
	}

	return user;
}

async function upsertAccessUser(
	env: Env,
	identity: { sub: string; email: string | null; name: string | null }
): Promise<SessionUser> {
	const db = getDb(env.ATTIC_DB);
	const id = `${CF_ACCESS_ID_PREFIX}${identity.sub}`;
	const email = identity.email ?? `${identity.sub}@cf-access.local`;
	const now = new Date();

	// One lookup covers both match rules; prefer the email match so a
	// pre-provisioned (invited) account adopts its assigned role instead of
	// colliding on the unique email, falling back to the Access-subject id for
	// accounts created before invites existed.
	const rows = await db
		.select()
		.from(schema.user)
		.where(or(eq(schema.user.email, email), eq(schema.user.id, id)))
		.limit(2);
	const existing = rows.find((u) => u.email === email) ?? rows[0];

	if (existing) {
		let role = (existing.role as UserRole) ?? 'member';
		// Bootstrap edge: while no admin exists, whoever signs in is promoted so
		// there is always someone who can manage the rest.
		if (role === 'member' && !(await hasAdmin(env))) {
			await db.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.id, existing.id));
			role = 'admin';
		}
		return {
			id: existing.id,
			sub: identity.sub,
			provider: 'cf-access',
			email: existing.email,
			name: existing.name,
			role,
			status: (existing.status as UserStatus) ?? 'pending'
		};
	}

	// Bootstrap: the deployment's first user (and any user while no admin
	// exists) is promoted to admin. The very first user also becomes the
	// protected owner and is active; everyone else waits for activation.
	const [adminExists, anyUser] = await Promise.all([hasAdmin(env), hasAnyUser(env)]);
	const role: UserRole = adminExists ? 'member' : 'admin';
	const status: UserStatus = anyUser ? 'pending' : 'active';
	await db.insert(schema.user).values({
		id,
		name: identity.name ?? identity.email ?? identity.sub,
		email,
		emailVerified: true,
		role,
		isOwner: !anyUser,
		status,
		createdAt: now,
		updatedAt: now
	});

	return {
		id,
		sub: identity.sub,
		provider: 'cf-access',
		email: identity.email,
		name: identity.name,
		role,
		status
	};
}

async function hasAdmin(env: Env): Promise<boolean> {
	const db = getDb(env.ATTIC_DB);
	const rows = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.user)
		.where(eq(schema.user.role, 'admin'));
	return (rows[0]?.n ?? 0) > 0;
}

async function hasAnyUser(env: Env): Promise<boolean> {
	const db = getDb(env.ATTIC_DB);
	const rows = await db.select({ n: sql<number>`count(*)` }).from(schema.user);
	return (rows[0]?.n ?? 0) > 0;
}
