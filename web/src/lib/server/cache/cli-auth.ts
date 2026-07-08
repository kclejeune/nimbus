// OAuth device-authorization endpoints for headless CLI login (RFC 8628),
// ported from the Rust worker's cli.rs. Machine-to-machine and
// unauthenticated: the browser-facing approval lives in the admin app, which
// writes the minted token into device_auth.

import * as db from './db';

type Env = App.Platform['env'];

const DEVICE_CODE_EXPIRY_SECS = 600;
const POLL_INTERVAL_SECS = 5;
/** Unambiguous user-code alphabet (no 0/O/1/I). */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function userCode(): string {
	const buf = new Uint8Array(8);
	crypto.getRandomValues(buf);
	const code = [...buf].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function adminBase(env: Env): string {
	return (env.APP_URL ?? '').replace(/\/+$/, '');
}

/** POST /_api/v1/cli/device — begin a device-authorization grant. */
export async function handleDeviceStart(env: Env): Promise<Response> {
	const deviceCode = randomHex(32);
	const code = userCode();
	const expiresAt = Math.floor(Date.now() / 1000) + DEVICE_CODE_EXPIRY_SECS;
	await db.createDeviceAuth(env.ATTIC_DB, deviceCode, code, expiresAt);

	const admin = adminBase(env);
	return json({
		device_code: deviceCode,
		user_code: code,
		verification_uri: `${admin}/cli/device`,
		verification_uri_complete: `${admin}/cli/device?code=${code}`,
		interval: POLL_INTERVAL_SECS,
		expires_in: DEVICE_CODE_EXPIRY_SECS
	});
}

/** Device-flow errors are HTTP 400 with an `error` code (RFC 8628). */
function deviceError(code: string): Response {
	return json({ error: code }, 400);
}

/** POST /_api/v1/cli/token — poll for the approved token. */
export async function handleDeviceToken(env: Env, deviceCode: string): Promise<Response> {
	const grant = await db.findDeviceAuth(env.ATTIC_DB, deviceCode);
	if (!grant) return deviceError('expired_token');

	if (grant.expires_at < Math.floor(Date.now() / 1000)) {
		await db.deleteDeviceAuth(env.ATTIC_DB, grant.device_code).catch(() => {});
		return deviceError('expired_token');
	}

	switch (grant.status) {
		case 'approved': {
			// One-time retrieval.
			await db.deleteDeviceAuth(env.ATTIC_DB, grant.device_code).catch(() => {});
			return json({ token: grant.token ?? '' });
		}
		case 'denied':
			await db.deleteDeviceAuth(env.ATTIC_DB, grant.device_code).catch(() => {});
			return deviceError('access_denied');
		default:
			return deviceError('authorization_pending');
	}
}

/** GET /_api/v1/auth-config — public login discovery for the CLI. */
export function handleAuthConfig(env: Env): Response {
	const admin = adminBase(env);
	return json({
		authorize_url: admin ? `${admin}/cli` : null,
		device_verification_url: admin ? `${admin}/cli/device` : null,
		device_authorization_endpoint: '/_api/v1/cli/device',
		token_endpoint: '/_api/v1/cli/token'
	});
}
