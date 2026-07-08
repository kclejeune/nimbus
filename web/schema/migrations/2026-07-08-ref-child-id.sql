-- GC traversal optimization. Apply once (after 2026-07-08-chunk-unique.sql);
-- schema.sql carries the same definitions for fresh installs.
--
-- object_ref edges gain a resolved child object id so closure CTEs walk
-- integer indexes instead of re-resolving 32-char hashes per step. The hash
-- stays the source of truth (parents can be pushed before children, and a
-- deleted child leaves the edge dangling); child_id is a cache maintained by
-- GC's ref-sync pass and cleared when the child object is deleted.
ALTER TABLE object_ref ADD COLUMN child_id INTEGER REFERENCES object(id);
CREATE INDEX IF NOT EXISTS idx_object_ref_child ON object_ref(child_id);
-- Dangling edges awaiting resolution (referenced path not yet pushed).
CREATE INDEX IF NOT EXISTS idx_object_ref_unresolved ON object_ref(ref_hash)
    WHERE child_id IS NULL;

UPDATE object_ref SET child_id = (
    SELECT o2.id FROM object o2
    WHERE o2.store_path_hash = object_ref.ref_hash
      AND o2.cache_id = (SELECT o1.cache_id FROM object o1 WHERE o1.id = object_ref.object_id)
);

-- Cached closure stats per GC root (refreshed by GC; the dashboard reads
-- these instead of recomputing closures per page view).
ALTER TABLE gc_root ADD COLUMN closure_objects INTEGER;
ALTER TABLE gc_root ADD COLUMN closure_bytes INTEGER;
ALTER TABLE gc_root ADD COLUMN stats_at TEXT;
