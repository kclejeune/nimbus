-- Hot NAR-by-hash lookups (findNarWithChunks, and the download-touch subquery
-- SELECT id FROM nar WHERE nar_hash IN (?, ?) AND state = 'V') filter on state
-- alongside nar_hash. With only idx_nar_hash(nar_hash) the planner could,
-- absent fresh ANALYZE statistics, fall back to idx_nar_state(state) and scan
-- every valid NAR (~28k rows/call at the time this bit, ~825M rows/day) — the
-- overload the nightly ANALYZE in worker-entry.ts works around. A composite
-- (nar_hash, state) makes the seek plan-independent of statistics. It fully
-- covers nar_hash-prefix lookups too, so it replaces the nar_hash-only index
-- and write amplification stays the same (one nar_hash-leading index before
-- and after). Idempotent; also in schema.sql. The composite is created before
-- the old index is dropped so a live database never has a moment without a
-- nar_hash-leading index — the exact gap this migration exists to close.
CREATE INDEX IF NOT EXISTS idx_nar_hash_state ON nar(nar_hash, state);
DROP INDEX IF EXISTS idx_nar_hash;
