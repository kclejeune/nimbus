-- Per-day ingest rollup for the Usage page's storage history. Joining
-- object → nar → chunkref → chunk over the whole instance on every page load
-- and range toggle cost 1.3 s and 340k rows read on prod at 43k paths, growing
-- with every push. Nightly GC rebuilds this from the live store for
-- the days before `ingest_rollup_until` (server_config); readers add a live
-- join over only the paths pushed since. Rebuilt whole each night: ~one row
-- per day of history, with no secondary index to bill.
CREATE TABLE IF NOT EXISTS ingest_day (
    day TEXT PRIMARY KEY, -- UTC date, YYYY-MM-DD
    paths INTEGER NOT NULL,
    bytes INTEGER NOT NULL
) WITHOUT ROWID;
