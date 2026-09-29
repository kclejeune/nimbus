#!/usr/bin/env node
// DEV ONLY. Fills the LOCAL wrangler D1 (.wrangler/state) with realistic mock
// data so every admin UI page has something to render under `npm run dev`,
// then prints a signed better-auth session cookie for the seeded admin.
//
//   npm run migrate:local
//   node scripts/dev-seed.mjs --local [--persist-to DIR]
//
// Refuses to run without --local and never passes --remote to wrangler. It
// WIPES every data table in the local database first (migration bookkeeping
// and the proxy keypair are kept), so re-running resets to the same dataset.
// Output is deterministic apart from "now"-relative timestamps; the session
// token is derived from SESSION_SECRET, so the cookie survives re-seeds as
// long as web/.dev.vars is unchanged.

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args.includes('--local') || args.includes('--remote')) {
	console.error(
		'dev-seed: refusing to run without --local (this script only seeds the local dev D1).'
	);
	process.exit(1);
}
const persistIdx = args.indexOf('--persist-to');
const target = [
	'--local',
	...(persistIdx >= 0 ? ['--persist-to', args[persistIdx + 1]] : []),
	...(existsSync(join(webDir, 'wrangler.local.jsonc')) ? ['--config=wrangler.local.jsonc'] : [])
];

// --- .dev.vars -----------------------------------------------------------------

function readDevVars() {
	const file = join(webDir, '.dev.vars');
	if (!existsSync(file)) {
		console.error('dev-seed: web/.dev.vars is missing; create it with SESSION_SECRET and APP_URL.');
		process.exit(1);
	}
	const vars = {};
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
	}
	return vars;
}
const devVars = readDevVars();
if (!devVars.SESSION_SECRET) {
	console.error('dev-seed: SESSION_SECRET is not set in web/.dev.vars.');
	process.exit(1);
}
const appUrl = devVars.APP_URL ?? 'http://localhost:5173';

// --- deterministic helpers ------------------------------------------------------

let rngState = 0x2026_0929;
function rand() {
	// mulberry32
	rngState = (rngState + 0x6d2b79f5) | 0;
	let t = rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const NIX32 = '0123456789abcdfghijklmnpqrsvwxyz';
const nixHash = () => Array.from({ length: 32 }, () => NIX32[Math.floor(rand() * 32)]).join('');
const hex = (n) =>
	Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const alnum = (n) =>
	Array.from(
		{ length: n },
		() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 62)]
	).join('');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const randBytes = (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
const uuid = () => {
	const h = hex(32);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const secs = (ms) => Math.floor(ms / 1000);
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** SQL literal. */
function q(v) {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v)) : 'NULL';
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (typeof v === 'object') v = JSON.stringify(v);
	return `'${String(v).replaceAll("'", "''")}'`;
}
const sql = [];
function insert(table, row) {
	const cols = Object.keys(row);
	sql.push(
		`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => q(row[c])).join(', ')});`
	);
}

/** Real Ed25519 keypair in Nix's `{name}:{base64(seed||pub)}` form. */
function nixKeypair(name) {
	const { privateKey } = generateKeyPairSync('ed25519');
	const jwk = privateKey.export({ format: 'jwk' });
	const seed = Buffer.from(jwk.d, 'base64url');
	const pub = Buffer.from(jwk.x, 'base64url');
	return `${name}:${Buffer.concat([seed, pub]).toString('base64')}`;
}

// --- wipe ---------------------------------------------------------------------

sql.push(
	...[
		'object_ref',
		'upstream_check',
		'cache_upstream',
		'gc_root',
		'pin',
		'chunkref',
		'chunk',
		'object',
		'nar',
		'upstream',
		'cache',
		'device_auth',
		'chunk_repair',
		'audit_log',
		'permission_grant',
		'group_member',
		'groups',
		'api_token',
		'revoked_token',
		'session',
		'account',
		'verification',
		'user'
	].map((t) => `DELETE FROM ${t};`),
	"DELETE FROM server_config WHERE key <> 'proxy_keypair';"
);

// --- users --------------------------------------------------------------------

const userId = (seed) =>
	createHash('sha256').update(`dev-seed-user:${seed}`).digest('base64url').slice(0, 32);
const users = [
	{
		key: 'kennan',
		name: 'Kennan LeJeune',
		email: 'kc@example.com',
		role: 'admin',
		owner: true,
		status: 'active',
		ageDays: 210
	},
	{
		key: 'priya',
		name: 'Priya Raman',
		email: 'priya.raman@example.com',
		role: 'admin',
		status: 'active',
		ageDays: 188
	},
	{
		key: 'marcus',
		name: 'Marcus Chen',
		email: 'marcus.chen@example.com',
		role: 'member',
		status: 'active',
		ageDays: 160
	},
	{
		key: 'sofia',
		name: 'Sofia Alvarez',
		email: 'sofia@example.com',
		role: 'member',
		status: 'active',
		ageDays: 131
	},
	{
		key: 'jonas',
		name: 'Jonas Becker',
		email: 'jonas.becker@example.com',
		role: 'member',
		status: 'active',
		ageDays: 97,
		cfAccess: true
	},
	{
		key: 'ci',
		name: 'CI Service',
		email: 'ci-bot@example.com',
		role: 'member',
		status: 'active',
		ageDays: 150,
		cfAccess: true
	},
	{
		key: 'lena',
		name: 'Lena Novak',
		email: 'lena.novak@example.com',
		role: 'member',
		status: 'pending',
		ageDays: 120,
		deactivated: true
	},
	{
		key: 'tomas',
		name: 'Tomás Herrera',
		email: 'tomas@contractor.example.net',
		role: 'member',
		status: 'active',
		ageDays: 44
	},
	{
		key: 'aiko',
		name: 'Aiko Tanaka',
		email: 'aiko.tanaka@example.com',
		role: 'member',
		status: 'pending',
		ageDays: 2
	},
	{
		key: 'daniel',
		name: 'daniel.okafor@example.com',
		email: 'daniel.okafor@example.com',
		role: 'member',
		status: 'pending',
		ageDays: 0.3
	}
];
const U = {};
for (const u of users) {
	u.id = u.cfAccess ? `cfaccess:${userId(u.key).slice(0, 24)}` : userId(u.key);
	u.createdMs = NOW - u.ageDays * DAY;
	U[u.key] = u;
	insert('user', {
		id: u.id,
		name: u.name,
		email: u.email,
		emailVerified: 1,
		image: null,
		role: u.role,
		is_owner: u.owner ? 1 : 0,
		status: u.status,
		createdAt: secs(u.createdMs),
		updatedAt: secs(u.deactivated ? NOW - 9 * DAY : u.createdMs + DAY)
	});
	if (!u.cfAccess) {
		insert('account', {
			id: alnum(32),
			accountId: u.key === 'kennan' ? '00u1kc8example' : `00u${alnum(10)}`,
			providerId: 'oidc',
			userId: u.id,
			scope: 'openid,email,profile,groups',
			createdAt: secs(u.createdMs),
			updatedAt: secs(NOW - randInt(0, 20) * DAY)
		});
	}
}
// The signed-in admin also has a linked GitHub account for /account.
insert('account', {
	id: alnum(32),
	accountId: '1297345',
	providerId: 'github',
	userId: U.kennan.id,
	scope: 'read:user,user:email',
	createdAt: secs(NOW - 180 * DAY),
	updatedAt: secs(NOW - 3 * DAY)
});

// --- sessions: the admin, plus a plain member for previewing role scoping -----

// Matches better-call's signCookieValue: `${value}.${base64(HMAC-SHA256)}`, URI-encoded.
function mintSession(label, userId) {
	const token = createHmac('sha256', devVars.SESSION_SECRET)
		.update(label)
		.digest('base64url')
		.slice(0, 32);
	insert('session', {
		id: alnum(32),
		token,
		expiresAt: secs(NOW + 365 * DAY),
		createdAt: secs(NOW),
		updatedAt: secs(NOW),
		ipAddress: '127.0.0.1',
		userAgent: 'dev-seed',
		userId
	});
	const signature = createHmac('sha256', devVars.SESSION_SECRET).update(token).digest('base64');
	return encodeURIComponent(`${token}.${signature}`);
}
const cookieValue = mintSession('nimbus-dev-seed-session', U.kennan.id);
const memberCookieValue = mintSession('nimbus-dev-seed-member-session', U.marcus.id);
const readerCookieValue = mintSession('nimbus-dev-seed-reader-session', U.tomas.id);
const cookieName = appUrl.startsWith('https://')
	? '__Secure-better-auth.session_token'
	: 'better-auth.session_token';

// --- groups and grants ----------------------------------------------------------

const ALL = { r: 1, w: 1, d: 1, cc: 1, cr: 1, cq: 1, cd: 1 };
const groups = [
	{
		key: 'platform',
		name: 'platform-team',
		description: 'Owns the cache fleet and CI infrastructure.',
		oidc: 'nimbus-platform',
		ageDays: 185,
		members: [
			['priya', 'sso'],
			['marcus', 'sso'],
			['kennan', 'manual']
		]
	},
	{
		key: 'ci',
		name: 'ci-runners',
		description: 'Service identities for GitHub Actions and Buildkite.',
		oidc: null,
		ageDays: 150,
		members: [
			['ci', 'manual'],
			['jonas', 'manual']
		]
	},
	{
		key: 'darwin',
		name: 'darwin-builders',
		description: 'macOS builders pushing aarch64-darwin closures.',
		oidc: 'nimbus-darwin',
		ageDays: 96,
		members: [
			['jonas', 'sso'],
			['sofia', 'sso']
		]
	},
	{
		key: 'contractors',
		name: 'contractors',
		description: 'Read-only access to the overlay caches.',
		oidc: null,
		ageDays: 45,
		members: [
			['tomas', 'manual'],
			['lena', 'manual']
		]
	},
	{
		key: 'readers',
		name: 'readers',
		description: null,
		oidc: 'nimbus_user',
		ageDays: 200,
		members: [
			['sofia', 'sso'],
			['marcus', 'sso'],
			['tomas', 'sso'],
			['jonas', 'sso']
		]
	}
];
const G = {};
for (const g of groups) {
	g.id = uuid();
	G[g.key] = g;
	insert('groups', {
		id: g.id,
		name: g.name,
		description: g.description,
		oidc_group: g.oidc,
		created_at: secs(NOW - g.ageDays * DAY)
	});
	for (const [uk, source] of g.members) {
		insert('group_member', {
			group_id: g.id,
			user_id: U[uk].id,
			source,
			created_at: secs(NOW - randInt(1, g.ageDays) * DAY)
		});
	}
}
const grants = [
	['group', G.platform.id, '*', { r: 1, w: 1, d: 1, cr: 1, cq: 1 }, 'kennan', 184],
	['group', G.ci.id, 'ci', { r: 1, w: 1 }, 'kennan', 149],
	['group', G.ci.id, 'staging', { r: 1, w: 1, d: 1 }, 'priya', 60],
	['group', G.darwin.id, 'darwin', { r: 1, w: 1, cr: 1 }, 'priya', 95],
	['group', G.contractors.id, 'nixpkgs-*', { r: 1 }, 'priya', 44],
	['group', G.readers.id, '*', { r: 1 }, 'kennan', 199],
	['user', U.kennan.id, 'main', ALL, 'kennan', 205],
	['user', U.marcus.id, 'nixpkgs-overlay', ALL, 'marcus', 140],
	['user', U.sofia.id, 'staging', { r: 1, w: 1, cr: 1, cq: 1 }, 'priya', 70],
	['user', U.tomas.id, 'darwin', { r: 1 }, 'priya', 30]
];
for (const [type, subject, pattern, actions, by, ageDays] of grants) {
	insert('permission_grant', {
		id: uuid(),
		subject_type: type,
		subject_id: subject,
		pattern,
		actions,
		created_at: secs(NOW - ageDays * DAY),
		created_by: U[by].id
	});
}

// --- API tokens -----------------------------------------------------------------

const tokens = [
	[
		'kennan',
		'laptop (nimbus push)',
		{ main: { r: 1, w: 1 }, darwin: { r: 1, w: 1 } },
		160,
		365,
		null
	],
	['kennan', 'github-actions: dotfiles', { main: { r: 1, w: 1 } }, 64, 90, null],
	['kennan', 'garbage collection cron', { '*': { r: 1, d: 1 } }, 40, null, null],
	['kennan', 'hydra evaluation test', { staging: { r: 1, w: 1 } }, 120, 30, null],
	['kennan', 'old ci token', { ci: { r: 1, w: 1 } }, 150, 365, 58],
	['kennan', 'read-only for demo', { 'nixpkgs-overlay': { r: 1 } }, 12, 7, null],
	['priya', 'buildkite agents', { ci: { r: 1, w: 1 }, staging: { r: 1, w: 1 } }, 90, 180, null],
	['priya', 'scratch', { '*': { r: 1 } }, 100, 14, null],
	['ci', 'gha-main-push', { main: { r: 1, w: 1 }, ci: { r: 1, w: 1 } }, 140, 365, null],
	['ci', 'gha-main-push (rotated)', { main: { r: 1, w: 1 } }, 200, 365, 141],
	['marcus', 'overlay publisher', { 'nixpkgs-overlay': { r: 1, w: 1, d: 1 } }, 75, 365, null],
	['sofia', 'staging deploys', { staging: { r: 1, w: 1 } }, 33, 60, null],
	['jonas', 'mac mini builder', { darwin: { r: 1, w: 1 } }, 80, 365, null],
	['lena', 'laptop', { main: { r: 1 } }, 110, 365, null]
];
for (const [uk, name, perms, ageDays, lifeDays, revokedDaysAgo] of tokens) {
	const created = NOW - ageDays * DAY;
	insert('api_token', {
		id: uuid(),
		user_id: U[uk].id,
		name,
		token_hash: hex(64),
		permissions: perms,
		expires_at: lifeDays === null ? null : secs(created + lifeDays * DAY),
		revoked_at: revokedDaysAgo === null ? null : secs(NOW - revokedDaysAgo * DAY),
		created_at: secs(created)
	});
}
for (let i = 0; i < 3; i++) {
	insert('revoked_token', {
		jti: uuid(),
		expires_at: secs(NOW + randInt(30, 300) * DAY),
		revoked_at: secs(NOW - randInt(5, 60) * DAY),
		reason: 'user.delete'
	});
}

// --- upstream registry ------------------------------------------------------------

const upstreams = [
	{
		url: 'https://cache.nixos.org',
		key: 'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
		ttl: 30 * 86400,
		mode: 'redirect',
		enforced: 1,
		nixDefault: 1,
		ageDays: 210
	},
	{
		url: 'https://nix-community.cachix.org',
		key: 'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=',
		ttl: 7 * 86400,
		mode: 'redirect',
		enforced: 0,
		nixDefault: 0,
		ageDays: 170
	},
	{
		url: 'https://devenv.cachix.org',
		key: 'devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
		ttl: 86400,
		mode: 'off',
		enforced: 0,
		nixDefault: 0,
		ageDays: 90
	},
	{
		url: 'https://cuda-maintainers.cachix.org',
		key: 'cuda-maintainers.cachix.org-1:0dq3bujKpuEPMCX6U4WylrUDZ9JyUG0VpVZa7CNfq5E=',
		ttl: 3 * 86400,
		mode: 'off',
		enforced: 0,
		nixDefault: 0,
		ageDays: 40
	}
];
upstreams.forEach((u, i) => {
	u.id = i + 1;
	insert('upstream', {
		id: u.id,
		url: u.url,
		public_key: u.key,
		ttl: u.ttl,
		default_mode: u.mode,
		enforced: u.enforced,
		position: i,
		nix_default: u.nixDefault,
		created_at: iso(NOW - u.ageDays * DAY)
	});
});

// --- caches -------------------------------------------------------------------

const caches = [
	{
		name: 'main',
		isPublic: 1,
		compression: 'zstd',
		priority: 40,
		retention: null,
		maxBytes: null,
		ageDays: 205,
		objects: 170
	},
	{
		name: 'ci',
		isPublic: 0,
		compression: 'zstd',
		priority: 41,
		retention: 30,
		maxBytes: 80 * GiB,
		ageDays: 150,
		objects: 120
	},
	{
		name: 'nixpkgs-overlay',
		isPublic: 1,
		compression: 'br',
		priority: 42,
		retention: null,
		maxBytes: null,
		ageDays: 140,
		objects: 45
	},
	{
		name: 'darwin',
		isPublic: 0,
		compression: 'zstd',
		priority: 40,
		retention: 90,
		maxBytes: 40 * GiB,
		ageDays: 95,
		objects: 70
	},
	{
		name: 'staging',
		isPublic: 0,
		compression: 'gzip',
		priority: 45,
		retention: 7,
		maxBytes: 10 * GiB,
		ageDays: 60,
		objects: 35
	},
	{
		name: 'old-experiments',
		isPublic: 0,
		compression: 'none',
		priority: 50,
		retention: 14,
		maxBytes: null,
		ageDays: 190,
		objects: 0,
		deletedDaysAgo: 120
	}
];
const C = {};
caches.forEach((c, i) => {
	c.id = i + 1;
	C[c.name] = c;
	insert('cache', {
		id: c.id,
		name: c.name,
		keypair: nixKeypair(`${c.name}.cache.example.com-1`),
		is_public: c.isPublic,
		store_dir: '/nix/store',
		priority: c.priority,
		upstream_cache_key_names: '[]',
		compression: c.compression,
		created_at: iso(NOW - c.ageDays * DAY),
		deleted_at: c.deletedDaysAgo ? iso(NOW - c.deletedDaysAgo * DAY) : null,
		retention_period: c.retention,
		retention_max_bytes: c.maxBytes
	});
});
// Per-cache upstream overrides (missing rows inherit default_mode).
for (const [cache, up, mode] of [
	['darwin', 2, 'persist'],
	['ci', 2, 'persist'],
	['ci', 4, 'redirect'],
	['staging', 3, 'redirect'],
	['nixpkgs-overlay', 2, 'off']
]) {
	insert('cache_upstream', { cache_id: C[cache].id, upstream_id: up, mode });
}

// --- store paths, NARs, chunks --------------------------------------------------

// [name, typical NAR size in bytes, systems]
const LINUX = 'x86_64-linux';
const ARM = 'aarch64-linux';
const DARWIN = 'aarch64-darwin';
const PKGS = [
	['glibc-2.40-66', 30 * MiB],
	['glibc-2.40-66-bin', 2.8 * MiB],
	['glibc-2.40-66-dev', 2.2 * MiB],
	['bash-5.2p37', 1.6 * MiB],
	['bash-interactive-5.2p37', 8.4 * MiB],
	['coreutils-9.5', 8.1 * MiB],
	['gnused-4.9', 800_000],
	['gnugrep-3.11', 1.1 * MiB],
	['gawk-5.3.1', 3.2 * MiB],
	['findutils-4.10.0', 1.7 * MiB],
	['openssl-3.3.2', 6.3 * MiB],
	['openssl-3.3.2-dev', 4.1 * MiB],
	['zlib-1.3.1', 140_000],
	['xz-5.6.3', 1.1 * MiB],
	['zstd-1.5.6', 1.9 * MiB],
	['libffi-3.4.6', 190_000],
	['ncurses-6.4.20221231', 3.4 * MiB],
	['readline-8.2p13', 1.2 * MiB],
	['sqlite-3.47.2', 2.9 * MiB],
	['curl-8.11.1', 1.4 * MiB],
	['curl-8.11.1-bin', 470_000],
	['libgit2-1.8.4', 1.5 * MiB],
	['git-2.47.1', 58 * MiB],
	['openssh-9.9p1', 5.3 * MiB],
	['gnupg-2.4.7', 12 * MiB],
	['python3-3.12.8', 112 * MiB],
	['python3.12-requests-2.32.3', 480_000],
	['python3.12-numpy-2.1.3', 42 * MiB],
	['nodejs-22.12.0', 76 * MiB],
	['nodejs-slim-22.12.0', 64 * MiB],
	['go-1.23.4', 245 * MiB],
	['rustc-1.83.0', 480 * MiB],
	['cargo-1.83.0', 38 * MiB],
	['rust-analyzer-2024-12-23', 51 * MiB],
	['gcc-14.2.1.20250322', 190 * MiB],
	['gcc-14.2.1.20250322-lib', 9.7 * MiB],
	['llvm-19.1.6-lib', 150 * MiB],
	['clang-19.1.6', 118 * MiB],
	['cmake-3.31.2', 52 * MiB],
	['ninja-1.12.1', 420_000],
	['meson-1.6.1', 9.2 * MiB],
	['pkg-config-wrapper-0.29.2', 90_000],
	['nix-2.25.3', 31 * MiB],
	['nix-2.25.3-man', 1.1 * MiB],
	['systemd-256.10', 61 * MiB],
	['linux-6.12.8', 18 * MiB],
	['linux-6.12.8-modules', 690 * MiB],
	['linux-firmware-20241210', 820 * MiB],
	['util-linux-2.40.2-bin', 5.7 * MiB],
	['dbus-1.14.10', 2.1 * MiB],
	['ripgrep-14.1.1', 5.4 * MiB],
	['fd-10.2.0', 3.9 * MiB],
	['jq-1.7.1-bin', 320_000],
	['bat-0.24.0', 5.9 * MiB],
	['neovim-unwrapped-0.10.3', 28 * MiB],
	['vim-9.1.0905', 36 * MiB],
	['tmux-3.5a', 1.1 * MiB],
	['zsh-5.9', 7.2 * MiB],
	['fish-3.7.1', 9.8 * MiB],
	['starship-1.21.1', 13 * MiB],
	['direnv-2.35.0', 9.1 * MiB],
	['nix-direnv-3.0.6', 45_000],
	['fzf-0.57.0', 4.3 * MiB],
	['htop-3.3.0', 420_000],
	['btop-1.4.0', 1.8 * MiB],
	['postgresql-16.6', 48 * MiB],
	['redis-7.2.6', 9.4 * MiB],
	['nginx-1.26.2', 3.8 * MiB],
	['caddy-2.8.4', 42 * MiB],
	['terraform-1.10.3', 91 * MiB],
	['kubectl-1.31.4', 57 * MiB],
	['helm-3.16.4', 54 * MiB],
	['k9s-0.32.7', 102 * MiB],
	['awscli2-2.22.26', 147 * MiB],
	['docker-27.3.1', 188 * MiB],
	['podman-5.3.1', 92 * MiB],
	['ffmpeg-7.1-bin', 4.2 * MiB],
	['ffmpeg-7.1-lib', 36 * MiB],
	['imagemagick-7.1.1-41', 24 * MiB],
	['firefox-unwrapped-134.0', 285 * MiB],
	['chromium-unwrapped-131.0.6778.204', 410 * MiB],
	['vscode-1.96.2', 395 * MiB],
	['alacritty-0.14.0', 11 * MiB],
	['wezterm-0-unstable-2024-12-21', 64 * MiB],
	['noto-fonts-2024.12.01', 280 * MiB],
	['jetbrains-mono-2.304', 9.8 * MiB],
	['fontconfig-2.15.0-lib', 870_000],
	['mesa-24.2.8', 390 * MiB],
	['gtk+3-3.24.43', 25 * MiB],
	['qtbase-6.8.1', 58 * MiB],
	['pipewire-1.2.7', 12 * MiB],
	['home-manager-path', 180_000],
	['home-manager-files', 95_000],
	['home-manager-generation', 60_000],
	['hm_fontconfigconf.d10hmfonts.conf', 2_000],
	['hm-session-vars.sh', 1_500],
	['nixos-system-atlas-25.05.20250107.a1b2c3d', 140_000],
	['nixos-system-borealis-25.05.20250107.a1b2c3d', 155_000],
	['etc', 480_000],
	['system-path', 260_000],
	['unit-script-nix-daemon-start', 3_000],
	['unit-nimbus-gc.service', 2_000],
	['initrd-linux-6.12.8', 23 * MiB],
	['source', 36 * MiB],
	['nimbus-0.8.0', 21 * MiB],
	['nimbus-web-0.8.0', 14 * MiB],
	['go-modules', 88 * MiB],
	['node_modules', 212 * MiB],
	['cargo-vendor-dir', 164 * MiB],
	['acme-api-2.14.0', 34 * MiB],
	['acme-web-2.14.0', 19 * MiB],
	['acme-worker-2.14.0', 27 * MiB],
	['acme-migrations-2.14.0', 400_000],
	['docker-image-acme-api.tar.gz', 96 * MiB]
];
const DARWIN_PKGS = [
	['darwin-system-25.05.a1b2c3d', 90_000],
	['nix-darwin-uninstaller', 40_000],
	['apple-sdk-14.4', 180 * MiB],
	['libiconv-107', 1.9 * MiB],
	['aerospace-0.16.2', 12 * MiB],
	['karabiner-elements-15.3.0', 58 * MiB],
	['raycast-1.88.4', 138 * MiB],
	['swift-5.10.1', 520 * MiB],
	['xcbuild-0.1.1-unstable-2019-11-20', 3.3 * MiB],
	['darwin-help-text', 5_000],
	['launchd-nimbus-push.plist', 1_200]
];

let narId = 0;
let chunkId = 0;
let objectId = 0;
let chunkrefId = 0;
const nars = []; // { id, size, fileSize, compression, hash }
const chunksByNar = new Map();
const objectsByCache = new Map(caches.map((c) => [c.name, []]));
const hashToNar = new Map();

const ratio = (compression) =>
	compression === 'none'
		? 1
		: compression === 'gzip'
			? 0.42 + rand() * 0.2
			: compression === 'br'
				? 0.3 + rand() * 0.15
				: 0.32 + rand() * 0.18;
// Mirrors cache/chunking.ts: NARs >= 8 MiB are cut into ~8 MiB (2-16 MiB) chunks.
const CHUNK_THRESHOLD = 8 * MiB;

function addChunk(rawSize, compression, forcedHash) {
	const id = ++chunkId;
	const h = forcedHash ?? `sha256:${hex(64)}`;
	const fileSize = Math.max(64, Math.round(rawSize * ratio(compression)));
	const key = `chunk/${h.slice(7, 9)}/${h.slice(7)}.${uuid()}${compression === 'none' ? '' : compression === 'zstd' ? '.zst' : compression === 'gzip' ? '.gz' : '.br'}`;
	insert('chunk', {
		id,
		state: 'V',
		chunk_hash: h,
		chunk_size: rawSize,
		file_hash: hex(64),
		file_size: fileSize,
		compression,
		remote_file: { bucket: 'cache', key },
		remote_file_id: key,
		holders_count: 0,
		held_at: null,
		created_at: iso(NOW - 200 * DAY)
	});
	return { id, hash: h, rawSize, compression };
}

/** A NAR with its chunk rows. `shareFrom` reuses part of another NAR's chunks. */
function addNar(size, compression, createdMs, shareFrom) {
	const id = ++narId;
	const narHash = `sha256:${hex(64)}`;
	const chunkRows = [];
	if (size < CHUNK_THRESHOLD) {
		chunkRows.push(addChunk(size, compression, narHash));
	} else {
		let left = size;
		let seq = 0;
		const donor = shareFrom ? chunksByNar.get(shareFrom) : null;
		while (left > 0) {
			// Content-defined chunks shared with a previous version dedup.
			const ch =
				donor?.[seq] && chance(0.65)
					? donor[seq]
					: addChunk(Math.min(left, randInt(2 * MiB, 16 * MiB)), compression);
			chunkRows.push(ch);
			left -= ch.rawSize;
			seq++;
		}
	}
	insert('nar', {
		id,
		state: 'V',
		nar_hash: narHash,
		nar_size: Math.round(size),
		compression,
		num_chunks: chunkRows.length,
		completeness_hint: 1,
		holders_count: 0,
		held_at: null,
		created_at: iso(createdMs)
	});
	chunkRows.forEach((ch, seq) => {
		insert('chunkref', {
			id: ++chunkrefId,
			nar_id: id,
			seq,
			chunk_id: ch.id,
			chunk_hash: ch.hash,
			compression: ch.compression
		});
	});
	chunksByNar.set(id, chunkRows);
	const nar = { id, size: Math.round(size), compression };
	nars.push(nar);
	return nar;
}

/** Skewed toward recent days, with weekday bursts, never before the cache existed. */
function pushTime(cache) {
	const maxAge = Math.min(cache.ageDays, cache.retention ?? 400);
	for (;;) {
		const ageDays = Math.pow(rand(), 1.7) * maxAge;
		const ms = NOW - ageDays * DAY - randInt(0, 23) * HOUR;
		const dow = new Date(ms).getUTCDay();
		if ((dow === 0 || dow === 6) && chance(0.65)) continue;
		return Math.min(ms, NOW - 5 * 60_000);
	}
}

const pushers = {
	main: ['kennan', 'ci', 'ci', 'priya'],
	ci: ['ci', 'ci', 'ci', 'jonas'],
	'nixpkgs-overlay': ['marcus', 'marcus', 'ci'],
	darwin: ['jonas', 'sofia', 'kennan'],
	staging: ['sofia', 'ci']
};
const sourcesFor = (cache) =>
	['ci', 'darwin'].includes(cache) && chance(0.12)
		? 'pullthrough:https://nix-community.cachix.org'
		: 'push';

function addObject(cacheName, pkgName, size, system, opts = {}) {
	const cache = C[cacheName];
	const created = opts.createdMs ?? pushTime(cache);
	const hash = opts.hash ?? nixHash();
	let nar = opts.nar;
	if (!nar) {
		nar = addNar(size * (0.85 + rand() * 0.3), cache.compression, created, opts.shareFrom);
	}
	hashToNar.set(hash, nar);
	const storePath = `/nix/store/${hash}-${pkgName}`;
	const existing = objectsByCache.get(cacheName);
	// References: a few earlier paths from the same cache, plus itself sometimes.
	const refs = [];
	const pool = existing.filter((o) => o.createdMs <= created);
	for (let i = 0, n = Math.min(pool.length, randInt(0, 6)); i < n; i++) {
		const r = pick(pool);
		const base = r.storePath.slice('/nix/store/'.length);
		if (!refs.includes(base)) refs.push(base);
	}
	if (chance(0.15))
		refs.push(
			`${nixHash()}-${pick(['glibc-2.40-66', 'gcc-14.2.1.20250322-lib', 'libunistring-1.2', 'libidn2-2.3.7'])}`
		);
	if (chance(0.3)) refs.push(`${hash}-${pkgName}`);
	const src = opts.source ?? sourcesFor(cacheName);
	const obj = { id: ++objectId, hash, storePath, createdMs: created, nar };
	insert('object', {
		id: obj.id,
		cache_id: cache.id,
		nar_id: nar.id,
		store_path_hash: hash,
		store_path: storePath,
		refs: refs.sort(),
		system,
		deriver:
			pkgName.endsWith('.conf') || pkgName.endsWith('.sh') ? null : `${nixHash()}-${pkgName}.drv`,
		sigs: [`${cacheName}.cache.example.com-1:${b64(randBytes(64))}`].concat(
			src.startsWith('pullthrough') ? [`nix-community.cachix.org-1:${b64(randBytes(64))}`] : []
		),
		ca:
			pkgName === 'source' || pkgName.startsWith('cargo-vendor')
				? `fixed:r:sha256:${nixHash()}${nixHash().slice(0, 20)}`
				: null,
		created_at: iso(created),
		last_accessed_at: chance(0.8)
			? iso(Math.min(NOW - randInt(1, 600) * 60_000, created + rand() * (NOW - created)))
			: null,
		created_by: src === 'push' ? U[pick(pushers[cacheName])].id : null,
		detached_at: opts.detached ? iso(NOW - randInt(1, 10) * DAY) : null,
		source: src
	});
	existing.push(obj);
	return obj;
}

// Sort pushes chronologically per cache so references point backwards.
for (const cache of caches) {
	if (cache.objects === 0) continue;
	const system = cache.name === 'darwin' ? DARWIN : LINUX;
	const pool = cache.name === 'darwin' ? [...DARWIN_PKGS, ...PKGS.slice(0, 70)] : PKGS;
	const plan = [];
	for (let i = 0; i < cache.objects; i++) {
		plan.push({ pkg: pick(pool), createdMs: pushTime(cache) });
	}
	plan.sort((a, b) => a.createdMs - b.createdMs);
	const lastNarByName = new Map();
	for (const { pkg, createdMs } of plan) {
		const [name, size] = pkg;
		const sys = cache.name === 'ci' && chance(0.25) ? ARM : system;
		// ci shares many NARs with main (same store path pushed to both caches).
		if (cache.name === 'ci' && chance(0.3)) {
			const inCi = new Set(objectsByCache.get('ci').map((o) => o.hash));
			const donor = pick(objectsByCache.get('main').filter((o) => !inCi.has(o.hash)));
			if (donor) {
				addObject('ci', donor.storePath.slice(44), 0, LINUX, {
					hash: donor.hash,
					nar: donor.nar,
					createdMs: Math.max(createdMs, donor.createdMs + HOUR)
				});
				continue;
			}
		}
		const obj = addObject(cache.name, name, size, sys, {
			createdMs,
			shareFrom: size >= CHUNK_THRESHOLD ? lastNarByName.get(name) : undefined,
			detached: cache.name === 'staging' && chance(0.08)
		});
		lastNarByName.set(name, obj.nar.id);
	}
}

// A deleted cache's leftovers are gone; GC-candidate counts for /settings:
// two NARs stuck mid-upload, one orphan NAR, and a few unreferenced chunks.
for (let i = 0; i < 2; i++) {
	insert('nar', {
		id: ++narId,
		state: 'P',
		nar_hash: `sha256:${hex(64)}`,
		nar_size: randInt(2, 90) * MiB,
		compression: 'zstd',
		num_chunks: 1,
		completeness_hint: 0,
		holders_count: 1,
		held_at: iso(NOW - randInt(2, 30) * 60_000),
		created_at: iso(NOW - randInt(2, 30) * 60_000)
	});
}
{
	const orphan = addNar(12 * MiB, 'zstd', NOW - 3 * DAY);
	void orphan;
}
for (let i = 0; i < 4; i++) addChunk(randInt(1, 20) * MiB, 'zstd');

// --- pins -----------------------------------------------------------------------

let pinId = 0;
function addPin(cacheName, name, keepRevisions, keepDays, revisions) {
	const cache = C[cacheName];
	const id = ++pinId;
	insert('pin', {
		id,
		cache_id: cache.id,
		name,
		keep_revisions: keepRevisions,
		keep_days: keepDays,
		created_at: iso(NOW - 100 * DAY)
	});
	const candidates = objectsByCache
		.get(cacheName)
		.filter((o) =>
			/nixos-system|darwin-system|home-manager-generation|acme-api|nimbus-0/.test(o.storePath)
		);
	const chosen = (
		candidates.length >= revisions ? candidates : objectsByCache.get(cacheName)
	).slice(-revisions);
	chosen.forEach((o, i) => {
		insert('gc_root', {
			cache_id: cache.id,
			store_path_hash: o.hash,
			note: i === chosen.length - 1 ? 'current' : null,
			pin_id: id,
			created_at: iso(o.createdMs + HOUR)
		});
	});
}
addPin('main', 'atlas', 5, null, 4);
addPin('main', 'hm-kennan', 3, null, 3);
addPin('main', 'release-0.8', null, null, 1);
addPin('darwin', 'macbook-pro', 10, 90, 3);
addPin('ci', 'last-green-main', 1, null, 1);
addPin('staging', 'acme-2.14', null, 14, 2);
for (const [cacheName, note] of [
	['main', 'keep: bootstrap toolchain'],
	['main', null],
	['nixpkgs-overlay', 'patched openssl for FIPS audit'],
	['ci', 'bisect baseline']
]) {
	const o = pick(objectsByCache.get(cacheName));
	insert('gc_root', {
		cache_id: C[cacheName].id,
		store_path_hash: o.hash,
		note,
		pin_id: null,
		created_at: iso(NOW - randInt(3, 60) * DAY)
	});
}

// --- audit log ------------------------------------------------------------------

const auditActors = ['kennan', 'kennan', 'kennan', 'priya', 'priya', 'marcus', 'sofia', 'jonas'];
const cacheNames = caches.filter((c) => !c.deletedDaysAgo).map((c) => c.name);
const auditMakers = [
	() => ({
		action: 'token.issue',
		target: uuid(),
		detail: JSON.stringify({ scope: pick(cacheNames), bits: { r: 1, w: 1 } })
	}),
	() => ({
		action: 'token.issue',
		target: uuid(),
		detail: JSON.stringify({ scope: '*', bits: { r: 1 }, via: 'cli' })
	}),
	() => ({ action: 'token.revoke', target: uuid() }),
	() => ({ action: 'cache.configure', target: pick(cacheNames) }),
	() => ({
		action: 'grant.create',
		target: uuid(),
		detail: `group:${pick(groups).id} ${pick([...cacheNames, 'nixpkgs-*', '*'])}`
	}),
	() => ({ action: 'grant.delete', target: uuid() }),
	() => ({
		action: 'group.member.add',
		target: pick(groups).id,
		detail: U[pick(Object.keys(U))].id
	}),
	() => ({
		action: 'group.member.remove',
		target: pick(groups).id,
		detail: U[pick(Object.keys(U))].id
	}),
	() => ({
		action: 'path.destroy',
		target: pick(cacheNames),
		detail: `${nixHash()}-${pick(PKGS)[0]}`
	}),
	() => ({ action: 'upstream.update', target: pick(upstreams).url }),
	() => ({ action: 'user.activate', target: U[pick(['marcus', 'sofia', 'jonas', 'tomas'])].id }),
	() => ({ action: 'gc.trigger', target: null })
];
const fixedAudit = [
	[205, 'kennan', 'cache.create', 'main'],
	[190, 'kennan', 'cache.create', 'old-experiments'],
	[150, 'kennan', 'cache.create', 'ci'],
	[140, 'marcus', 'cache.create', 'nixpkgs-overlay'],
	[120, 'kennan', 'cache.destroy', 'old-experiments'],
	[95, 'priya', 'cache.create', 'darwin'],
	[60, 'priya', 'cache.create', 'staging'],
	[61, 'priya', 'cache.rename', 'staging-old', 'staging'],
	[45, 'priya', 'group.create', G.contractors.id, 'contractors'],
	[44, 'priya', 'group.mapping', G.darwin.id, 'nimbus-darwin'],
	[40, 'kennan', 'upstream.add', 'https://cuda-maintainers.cachix.org'],
	[33, 'kennan', 'upstream.remove', 'https://hydra.example.org'],
	[9, 'priya', 'user.deactivate', U.lena.id],
	[2, 'kennan', 'group.delete', uuid()]
];
for (const [ageDays, actor, action, target, detail] of fixedAudit) {
	insert('audit_log', {
		id: uuid(),
		user_id: U[actor].id,
		action,
		target,
		detail: detail ?? null,
		created_at: secs(NOW - ageDays * DAY - randInt(0, 8) * HOUR)
	});
}
for (let i = 0; i < 160; i++) {
	const entry = pick(auditMakers)();
	const system = entry.action === 'gc.trigger' && chance(0.3);
	insert('audit_log', {
		id: uuid(),
		user_id: system ? null : U[pick(auditActors)].id,
		action: entry.action,
		target: entry.target,
		detail: entry.detail ?? null,
		created_at: secs(NOW - Math.pow(rand(), 1.4) * 42 * DAY)
	});
}

// --- server_config: storage ceiling + last GC run ---------------------------------

insert('server_config', { key: 'global_max_bytes', value: String(250 * GiB) });
const lastGcAt = (() => {
	const d = new Date(NOW);
	d.setUTCHours(3, 0, 42, 0);
	if (d.getTime() > NOW) d.setTime(d.getTime() - DAY);
	return d.toISOString();
})();
const incomplete = objectsByCache
	.get('ci')
	.slice(-3)
	.map((o) => o.storePath);
// Instance totals are computed in SQL from the rows just inserted, exactly as
// instanceStats() would (the dashboards read this snapshot).
sql.push(`INSERT INTO server_config (key, value) SELECT 'gc_last_run', json_object(
	'at', ${q(lastGcAt)},
	'stats', json_object(
		'abandoned_caches_reaped', 0, 'detached_objects_reaped', 3, 'expired_objects_reaped', 41,
		'size_evicted_objects', 6, 'global_evicted_objects', 0, 'orphan_nars_reaped', 12,
		'orphan_chunks_reaped', 57, 'pin_revisions_pruned', 2, 'incomplete_closure_objects', ${incomplete.length},
		'integrity_refs_probed', 118, 'refs_synced', 264, 'narinfo_tags_purged', 47,
		'narinfo_tags_queued', 0, 'narinfo_tags_failed', 0, 'skipped_lock_held', 0),
	'integrity', json_object('incompleteObjects', ${incomplete.length}, 'examples', json(${q(JSON.stringify(incomplete))})),
	'instance', json_object(
		'caches', (SELECT COUNT(*) FROM cache WHERE deleted_at IS NULL),
		'objects', (SELECT COUNT(*) FROM object o JOIN cache c ON c.id = o.cache_id WHERE c.deleted_at IS NULL),
		'nars', (SELECT COUNT(*) FROM nar WHERE state = 'V'),
		'storageBytes', (SELECT COALESCE(SUM(file_size), 0) FROM chunk WHERE state = 'V'),
		'logicalBytes', (SELECT COALESCE(SUM(sz.bytes), 0) FROM object o JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz ON sz.nar_id = o.nar_id)));`);

// --- run --------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-dev-seed-'));
try {
	const file = join(scratch, 'seed.sql');
	writeFileSync(file, sql.join('\n') + '\n');
	const res = spawnSync(
		join(webDir, 'node_modules/.bin/wrangler'),
		['d1', 'execute', 'ATTIC_DB', '--yes', `--file=${file}`, ...target],
		{ cwd: webDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
	);
	if (res.status !== 0) {
		console.error(res.stdout, res.stderr);
		console.error('dev-seed: wrangler d1 execute failed');
		process.exit(res.status ?? 1);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

const totalObjects = [...objectsByCache.values()].reduce((n, l) => n + l.length, 0);
console.log(
	`dev-seed: ${users.length} users, ${groups.length} groups, ${caches.length} caches, ` +
		`${totalObjects} store paths, ${narId} NARs, ${chunkId} chunks, ${tokens.length} tokens, ` +
		`${fixedAudit.length + 160} audit entries`
);
console.log(
	`\nSigned in as ${U.kennan.name} <${U.kennan.email}> (admin, owner). Session cookie:\n`
);
console.log(`  ${cookieName}=${cookieValue}\n`);
console.log(`  curl -b '${cookieName}=${cookieValue}' ${appUrl}/`);
console.log(`\nMember (${U.marcus.name}, no admin role), for previewing role scoping:`);
console.log(`  ${cookieName}=${memberCookieValue}`);
console.log(`\nReader (${U.tomas.name}, pull-only everywhere):`);
console.log(`  ${cookieName}=${readerCookieValue}`);
console.log(
	`\nIn a browser: open ${appUrl}, then in devtools run\n  document.cookie = "${cookieName}=${cookieValue}; path=/"\nand reload.`
);
