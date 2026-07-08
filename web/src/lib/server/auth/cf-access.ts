import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db';
import type { SessionUser, UserRole } from './types';

type Env = App.Platform['env'];

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

async function mintSessionToken(userId: string, role: UserRole, secret: string): Promise<string> {
	const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	// userId may contain colons (e.g. "cfaccess:<sub>"), so we parse from the right on verify.
	const payload = `${userId}:${role}:${expiry}`;
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return `${payload}.${b64url(sig)}`;
}

async function verifySessionToken(
	value: string,
	secret: string
): Promise<Pick<SessionUser, 'id' | 'role'> | null> {
	const dotIdx = value.lastIndexOf('.');
	if (dotIdx === -1) return null;
	const payload = value.slice(0, dotIdx);
	const sigB64 = value.slice(dotIdx + 1);

	// Split from the right: userId may contain colons (e.g. "cfaccess:<sub>").
	const parts = payload.split(':');
	if (parts.length < 3) return null;
	const expiryStr = parts[parts.length - 1];
	const role = parts[parts.length - 2];
	const userId = parts.slice(0, parts.length - 2).join(':');

	const expiry = parseInt(expiryStr, 10);
	if (isNaN(expiry) || Math.floor(Date.now() / 1000) > expiry) return null;
	if (role !== 'admin' && role !== 'member') return null;

	const key = await importHmacKey(secret);
	const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
		c.charCodeAt(0)
	);
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		sigBytes,
		new TextEncoder().encode(payload)
	);
	if (!valid) return null;

	return { id: userId, role: role as UserRole };
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

	// Check session cookie before hitting D1.
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
					role: cached.role
				};
			}
		}
	}

	// Full D1 resolution (first visit or expired/invalid cookie).
	const user = await upsertAccessUser(env, { sub, email, name: payload.name ?? email });

	// Mint a fresh session cookie to skip D1 on subsequent requests.
	if (sessionSecret) {
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
	const id = `cfaccess:${identity.sub}`;
	const email = identity.email ?? `${identity.sub}@cf-access.local`;
	const now = new Date();

	// Bootstrap: the deployment's first user (and any user while no admin exists)
	// is promoted to admin so there is always someone who can manage the rest. The
	// very first user also becomes the protected owner.
	const [adminExists, anyUser] = await Promise.all([hasAdmin(env), hasAnyUser(env)]);

	// Match by email first so a pre-provisioned (invited) account adopts its
	// assigned role instead of colliding on the unique email; fall back to the
	// Access-subject id for accounts created before invites existed.
	let existing = await db.select().from(schema.user).where(eq(schema.user.email, email)).limit(1);
	if (existing.length === 0) {
		existing = await db.select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
	}
	if (existing.length > 0) {
		const u = existing[0];
		let role = (u.role as UserRole) ?? 'member';
		if (role === 'member' && !adminExists) {
			await db.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.id, u.id));
			role = 'admin';
		}
		return {
			id: u.id,
			sub: identity.sub,
			provider: 'cf-access',
			email: u.email,
			name: u.name,
			role
		};
	}

	const role: UserRole = adminExists ? 'member' : 'admin';
	await db.insert(schema.user).values({
		id,
		name: identity.name ?? identity.email ?? identity.sub,
		email,
		emailVerified: true,
		role,
		isOwner: !anyUser,
		createdAt: now,
		updatedAt: now
	});

	return {
		id,
		sub: identity.sub,
		provider: 'cf-access',
		email: identity.email,
		name: identity.name,
		role
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
