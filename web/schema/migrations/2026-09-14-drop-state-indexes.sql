-- Drop the single-column state indexes on nar and chunk. Both tables are
-- written on every push (nar: create + finalize, chunk: stage + link), so each
-- index bills a row per write, and nothing reads them in a way the index
-- helps:
--   - hot lookups go through idx_nar_hash_state / idx_chunk_hash;
--   - GC's size aggregates and the stats page SUM over the whole table, which
--     the planner serves by scanning it (the index carries no size column);
--   - the settings page's COUNT(*) WHERE state='P' becomes a ~30k-row scan
--     once a day, which is noise next to the per-push write rows saved;
--   - GC's chunk reap deletes by rowid.
-- state is a one-byte column with two or three distinct values, so the index
-- never had selectivity to offer. Idempotent; schema.sql carries the same
-- state.
DROP INDEX IF EXISTS idx_nar_state;
DROP INDEX IF EXISTS idx_chunk_state;
