-- Repairs must survive a lost response or a failed purge. No foreign key:
-- GC may remove the chunk before its old R2 representation is retired.
CREATE TABLE IF NOT EXISTS chunk_repair (
    new_key TEXT PRIMARY KEY,
    chunk_id INTEGER NOT NULL,
    old_key TEXT,
    object_cursor INTEGER NOT NULL DEFAULT 0,
    retire_after INTEGER
);
