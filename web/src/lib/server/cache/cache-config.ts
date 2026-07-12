// Cache configuration, ported from the Rust worker's cache_config.rs. The
// plain functions are shared: the router's HTTP handlers wrap them, and the
// admin UI calls them in-process (no more service-binding hop).

import { validateCompressionConfig } from './compression/config';
import * as db from './db';
import { extractPublicKey, generateKeypair } from '../attic/signing';

type Env = App.Platform['env'];

const CACHE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

// Names that collide with root-proxy routes on the cache host.
const RESERVED_CACHE_NAMES = new Set(['nar', 'nix-cache-info']);

export class CacheConfigError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export interface CreateCacheOptions {
	is_public?: boolean;
	store_dir?: string;
	priority?: number;
	compression?: string;
	retention_period?: number | null;
}

/** Create a cache with a fresh keypair; returns the public key. */
export async function createCache(
	env: Env,
	name: string,
	options: CreateCacheOptions
): Promise<{ public_key: string }> {
	if (!CACHE_NAME_RE.test(name) || RESERVED_CACHE_NAMES.has(name)) {
		throw new CacheConfigError(400, `Invalid cache name: ${name}`);
	}

	const existing = await db.findCache(env.ATTIC_DB, name);
	if (existing) throw new CacheConfigError(409, `A cache named "${name}" already exists`);
	// A soft-deleted tombstone frees its name (and storage) on reuse.
	await db.purgeDeletedCache(env.ATTIC_DB, name);

	const compression = validateCompressionConfig(options.compression ?? 'zstd');
	if (!compression) {
		throw new CacheConfigError(400, `Unsupported compression: ${options.compression}`);
	}

	const keypair = await generateKeypair(name);
	await db.createCacheRow(env.ATTIC_DB, {
		name,
		keypair,
		is_public: options.is_public ?? false,
		store_dir: options.store_dir ?? '/nix/store',
		priority: options.priority ?? 40,
		compression,
		retention_period: options.retention_period ?? null
	});

	return { public_key: extractPublicKey(keypair) };
}

export interface ConfigureCacheOptions {
	is_public?: boolean;
	store_dir?: string;
	priority?: number;
	compression?: string;
	/** undefined = unchanged; null = clear. Days. */
	retention_period?: number | null;
	/** undefined = unchanged; null = clear. Compressed bytes. */
	retention_max_bytes?: number | null;
	upstream_cache_key_names?: string[];
	keypair?: { type: 'generate' } | { type: 'set'; keypair: string };
}

/** Update cache settings; returns the new public key if the keypair changed. */
export async function configureCache(
	env: Env,
	name: string,
	options: ConfigureCacheOptions
): Promise<{ public_key?: string }> {
	const cache = await db.findCache(env.ATTIC_DB, name);
	if (!cache) throw new CacheConfigError(404, `Cache not found: ${name}`);

	let compression: string | undefined;
	if (options.compression !== undefined) {
		const validated = validateCompressionConfig(options.compression);
		if (!validated) {
			throw new CacheConfigError(400, `Unsupported compression: ${options.compression}`);
		}
		compression = validated;
	}

	let keypair: string | undefined;
	if (options.keypair?.type === 'generate') {
		keypair = await generateKeypair(name);
	} else if (options.keypair?.type === 'set') {
		try {
			extractPublicKey(options.keypair.keypair);
		} catch (e) {
			throw new CacheConfigError(400, `Invalid keypair: ${e}`);
		}
		keypair = options.keypair.keypair;
	}

	await db.updateCache(env.ATTIC_DB, name, {
		is_public: options.is_public,
		store_dir: options.store_dir,
		priority: options.priority,
		compression,
		...('retention_period' in options ? { retention_period: options.retention_period } : {}),
		...('retention_max_bytes' in options
			? { retention_max_bytes: options.retention_max_bytes }
			: {}),
		upstream_cache_key_names: options.upstream_cache_key_names,
		keypair
	});

	return keypair ? { public_key: extractPublicKey(keypair) } : {};
}

/** Soft-delete a cache (data retained until GC's abandoned-cache reap). */
export async function destroyCache(env: Env, name: string): Promise<void> {
	const deleted = await db.softDeleteCache(env.ATTIC_DB, name);
	if (!deleted) throw new CacheConfigError(404, `Cache not found: ${name}`);
}

/** Rename, keeping the keypair so existing signatures stay valid. */
export async function renameCache(env: Env, oldName: string, newName: string): Promise<void> {
	if (!CACHE_NAME_RE.test(newName) || RESERVED_CACHE_NAMES.has(newName)) {
		throw new CacheConfigError(400, `Invalid cache name: ${newName}`);
	}
	if (oldName === newName) {
		throw new CacheConfigError(400, 'New name matches the current name');
	}
	await db.purgeDeletedCache(env.ATTIC_DB, newName);
	const outcome = await db.renameCacheRow(env.ATTIC_DB, oldName, newName);
	if (outcome === 'not_found') throw new CacheConfigError(404, `Cache not found: ${oldName}`);
	if (outcome === 'conflict') {
		throw new CacheConfigError(409, `A cache named "${newName}" already exists`);
	}
}

/** The public discovery document (attic-cache-info / GET cache-config). */
export async function cacheInfo(env: Env, name: string, baseUrl: string): Promise<object> {
	const cache = await db.findCache(env.ATTIC_DB, name);
	if (!cache) throw new CacheConfigError(404, `Cache not found: ${name}`);

	let publicKey: string;
	try {
		publicKey = extractPublicKey(cache.keypair);
	} catch {
		publicKey = cache.keypair;
	}

	let upstreamKeyNames: string[] = [];
	try {
		const parsed = JSON.parse(cache.upstream_cache_key_names);
		if (Array.isArray(parsed)) upstreamKeyNames = parsed;
	} catch {
		// tolerate malformed rows; the field is only a hint
	}

	return {
		substituter_endpoint: `${baseUrl}/${name}/`,
		api_endpoint: `${baseUrl}/`,
		public_key: publicKey,
		is_public: cache.is_public === 1,
		store_dir: cache.store_dir,
		priority: cache.priority,
		compression: cache.compression,
		upstream_cache_key_names: upstreamKeyNames,
		retention_period: cache.retention_period,
		retention_max_bytes: cache.retention_max_bytes,
		worker_capabilities: {
			preamble_nar_info: true,
			server_signing: true,
			server_compression: true
		}
	};
}
