-- Retention overhaul: dependency tracking, GC roots, size budgets, upstream caches.
-- Apply once to existing databases (the ALTERs are not idempotent);
-- schema.sql carries the same definitions for fresh installs.
-- Backfill of object_ref happens on the first GC run (batched by object id).

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

-- Cached upstream narinfo existence checks (get-missing-paths filtering).
CREATE TABLE IF NOT EXISTS upstream_check (
    upstream TEXT NOT NULL,
    store_path_hash TEXT NOT NULL,
    present INTEGER NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (upstream, store_path_hash)
);

-- Size budget in bytes (compressed, per cache); NULL = unlimited.
ALTER TABLE cache ADD COLUMN retention_max_bytes INTEGER;

-- Upstream binary caches whose paths clients should not push here.
ALTER TABLE cache ADD COLUMN upstream_caches TEXT NOT NULL DEFAULT '["https://cache.nixos.org"]';
