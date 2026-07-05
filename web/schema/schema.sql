-- Attic Worker Database Schema
-- Compatible with SQLite (D1/Turso)

-- Cache table
CREATE TABLE IF NOT EXISTS cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    keypair TEXT NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 0,
    store_dir TEXT NOT NULL DEFAULT '/nix/store',
    priority INTEGER NOT NULL DEFAULT 40,
    upstream_cache_key_names TEXT NOT NULL DEFAULT '[]',
    compression TEXT NOT NULL DEFAULT 'br', -- none, zstd, br, gzip
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    retention_period INTEGER,
    retention_max_bytes INTEGER, -- size budget in compressed bytes; NULL = unlimited
    upstream_caches TEXT NOT NULL DEFAULT '["https://cache.nixos.org"]'
);

CREATE INDEX IF NOT EXISTS idx_cache_name ON cache(name);
CREATE INDEX IF NOT EXISTS idx_cache_deleted ON cache(deleted_at);

-- Direct references between store paths, derived from object.refs JSON.
-- ref_hash is the 32-char store path hash of the referenced path; resolution
-- to an object row is per-cache via (cache_id, store_path_hash).
CREATE TABLE IF NOT EXISTS object_ref (
    object_id INTEGER NOT NULL REFERENCES object(id),
    ref_hash TEXT NOT NULL,
    PRIMARY KEY (object_id, ref_hash)
);
CREATE INDEX IF NOT EXISTS idx_object_ref_ref_hash ON object_ref(ref_hash);

-- Pinned store paths: GC always keeps the full closure of every root.
CREATE TABLE IF NOT EXISTS gc_root (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_id INTEGER NOT NULL REFERENCES cache(id),
    store_path_hash TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (cache_id, store_path_hash)
);

-- Server-wide settings (key/value), e.g. global_max_bytes (physical storage
-- ceiling across all caches, enforced by GC's global eviction pass).
CREATE TABLE IF NOT EXISTS server_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Cached upstream narinfo existence checks (get-missing-paths filtering).
CREATE TABLE IF NOT EXISTS upstream_check (
    upstream TEXT NOT NULL,
    store_path_hash TEXT NOT NULL,
    present INTEGER NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (upstream, store_path_hash)
);

-- NAR table (content-addressed)
CREATE TABLE IF NOT EXISTS nar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL DEFAULT 'P', -- V=Valid, P=PendingUpload, C=ConfirmedDeduplicated, D=Deleted
    nar_hash TEXT NOT NULL,
    nar_size INTEGER NOT NULL,
    compression TEXT NOT NULL DEFAULT 'none',
    num_chunks INTEGER NOT NULL DEFAULT 1,
    completeness_hint INTEGER NOT NULL DEFAULT 0,
    holders_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nar_hash ON nar(nar_hash);
CREATE INDEX IF NOT EXISTS idx_nar_state ON nar(state);

-- Object table (cache-specific view of a NAR)
CREATE TABLE IF NOT EXISTS object (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_id INTEGER NOT NULL REFERENCES cache(id),
    nar_id INTEGER NOT NULL REFERENCES nar(id),
    store_path_hash TEXT NOT NULL,
    store_path TEXT NOT NULL,
    refs TEXT NOT NULL DEFAULT '[]',
    system TEXT,
    deriver TEXT,
    sigs TEXT NOT NULL DEFAULT '[]',
    ca TEXT,
    created_at TEXT NOT NULL,
    last_accessed_at TEXT,
    created_by TEXT,
    UNIQUE(cache_id, store_path_hash)
);

CREATE INDEX IF NOT EXISTS idx_object_cache_hash ON object(cache_id, store_path_hash);
CREATE INDEX IF NOT EXISTS idx_object_nar ON object(nar_id);
-- Store-path browsing: order/filter by date or name within a cache.
CREATE INDEX IF NOT EXISTS idx_object_cache_created ON object(cache_id, created_at);
CREATE INDEX IF NOT EXISTS idx_object_cache_path ON object(cache_id, store_path);

-- Chunk table (deduplicated storage units)
CREATE TABLE IF NOT EXISTS chunk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL DEFAULT 'P', -- V=Valid, P=PendingUpload, C=ConfirmedDeduplicated, D=Deleted
    chunk_hash TEXT NOT NULL,
    chunk_size INTEGER NOT NULL,
    file_hash TEXT,
    file_size INTEGER,
    compression TEXT NOT NULL DEFAULT 'none',
    remote_file TEXT NOT NULL, -- JSON-encoded RemoteFile
    remote_file_id TEXT NOT NULL,
    holders_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_hash ON chunk(chunk_hash, compression);
CREATE INDEX IF NOT EXISTS idx_chunk_state ON chunk(state);

-- ChunkRef table (NAR to chunk mapping)
CREATE TABLE IF NOT EXISTS chunkref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nar_id INTEGER NOT NULL REFERENCES nar(id),
    seq INTEGER NOT NULL,
    chunk_id INTEGER REFERENCES chunk(id),
    chunk_hash TEXT NOT NULL,
    compression TEXT NOT NULL DEFAULT 'none'
);

CREATE INDEX IF NOT EXISTS idx_chunkref_nar ON chunkref(nar_id, seq);
CREATE INDEX IF NOT EXISTS idx_chunkref_chunk ON chunkref(chunk_id);

-- Pending chunked-upload state (server-side; the client holds only an opaque token)
CREATE TABLE IF NOT EXISTS pending_upload (
    token TEXT PRIMARY KEY,
    cache_id INTEGER NOT NULL REFERENCES cache(id),
    cache_name TEXT NOT NULL,
    r2_upload_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    nar_info TEXT NOT NULL,
    expected_nar_size INTEGER NOT NULL,
    compression TEXT NOT NULL,
    parts_uploaded INTEGER NOT NULL DEFAULT 0,
    bytes_received INTEGER NOT NULL DEFAULT 0,
    uploaded_parts TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_upload_created ON pending_upload(created_at);

-- OAuth device-authorization grants for headless CLI login
CREATE TABLE IF NOT EXISTS device_auth (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
    scope TEXT,
    user_id TEXT,
    token TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_auth_user_code ON device_auth(user_code);

-- Migrations tracking table
CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);
