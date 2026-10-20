-- Atomically pair path removal with a durable edge-invalidation obligation.
CREATE TABLE IF NOT EXISTS path_purge (
    id TEXT PRIMARY KEY,
    cache_id INTEGER NOT NULL,
    cache_name TEXT NOT NULL,
    objects TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    tag_cursor INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
);
