-- Dedup-integrity overhaul. Apply once to existing databases;
-- schema.sql carries the same definitions for fresh installs.
--
-- chunk(chunk_hash, compression) was a plain index, so racing uploads of the
-- same chunk could insert duplicate rows sharing one content-addressed R2
-- object; GC reaping the orphaned duplicate then deleted the object out from
-- under the surviving row. Collapse duplicates onto a canonical row and
-- enforce uniqueness (which also activates the upload path's adopt-on-conflict
-- handling).

-- Repoint chunkrefs at the canonical row (valid rows win, then lowest id).
UPDATE chunkref
SET chunk_id = (
    SELECT c.id FROM chunk c
    WHERE c.chunk_hash = chunkref.chunk_hash AND c.compression = chunkref.compression
    ORDER BY (c.state <> 'V'), c.id LIMIT 1
)
WHERE chunk_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM chunk c
    WHERE c.chunk_hash = chunkref.chunk_hash AND c.compression = chunkref.compression
);

-- Drop the non-canonical duplicates (rows only; they share the R2 object).
DELETE FROM chunk WHERE id NOT IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY chunk_hash, compression
            ORDER BY (state <> 'V'), id
        ) AS rn FROM chunk
    ) WHERE rn = 1
);

DROP INDEX IF EXISTS idx_chunk_hash;
CREATE UNIQUE INDEX idx_chunk_hash ON chunk(chunk_hash, compression);

-- holders_count now guards orphan reaping (GC skips held rows, closing the
-- dedup-vs-reap race), with held_at letting GC distinguish an active hold
-- (minutes old) from one leaked by a crashed request. Under the old scheme
-- rows were created at 1 and never released, so clear the stale counts;
-- in-flight uploads during the migration are still covered by the 1h orphan
-- grace period.
ALTER TABLE nar ADD COLUMN held_at TEXT;
ALTER TABLE chunk ADD COLUMN held_at TEXT;
UPDATE chunk SET holders_count = 0;
UPDATE nar SET holders_count = 0;

-- The R2-multipart pending-upload flow was replaced by the stateless CDC
-- protocol before release; the table is dead weight.
DROP TABLE IF EXISTS pending_upload;
