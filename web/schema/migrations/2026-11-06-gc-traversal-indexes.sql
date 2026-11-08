-- Reduce GC's graph traversal and detached-object discovery work. The
-- 2026-11-06 production trace read about 1.83M rows per closure walk and
-- about 78k rows to find caches with detached objects.
--
-- Cover forward walks using only resolved references. Keep the existing
-- child_id and ref_hash indexes for reverse walks and unresolved checks.
CREATE INDEX IF NOT EXISTS idx_object_ref_resolved_parent ON object_ref(object_id, child_id)
    WHERE child_id IS NOT NULL;

-- Keep ordinary uploads out of the detached-object index. Entries change
-- when paths are detached, re-pushed, or deleted.
CREATE INDEX IF NOT EXISTS idx_object_detached_cache ON object(cache_id, id)
    WHERE detached_at IS NOT NULL;
