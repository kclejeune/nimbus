-- Server-wide settings (key/value). First use: global_max_bytes — a physical
-- storage ceiling across all caches (deduplicated chunk bytes), enforced by a
-- global LRU eviction pass in GC. Idempotent; also in schema.sql.
CREATE TABLE IF NOT EXISTS server_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
