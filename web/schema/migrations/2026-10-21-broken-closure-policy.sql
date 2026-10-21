-- Disabled until explicitly configured per cache. Existing object age never
-- backdates the confirmation clock.
ALTER TABLE cache ADD COLUMN purge_broken_after_days INTEGER CHECK (purge_broken_after_days BETWEEN 1 AND 3650);

CREATE TABLE IF NOT EXISTS broken_purge_state (
    cache_id INTEGER PRIMARY KEY REFERENCES cache(id) ON DELETE CASCADE,
    policy_days INTEGER NOT NULL,
    upstream_config TEXT NOT NULL,
    after_hash TEXT NOT NULL DEFAULT '',
    last_run_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broken_reference (
    cache_id INTEGER NOT NULL REFERENCES cache(id) ON DELETE CASCADE,
    ref_hash TEXT NOT NULL,
    upstream_config TEXT NOT NULL,
    first_missing_at TEXT NOT NULL,
    last_checked_at TEXT NOT NULL,
    PRIMARY KEY (cache_id, ref_hash)
);
CREATE INDEX IF NOT EXISTS idx_broken_reference_checked ON broken_reference(cache_id, last_checked_at, ref_hash);
