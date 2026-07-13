-- Upstream registry, named pins, detach semantics, provenance.
-- Apply once to existing databases (the ALTERs and table rebuilds are not
-- idempotent); schema.sql carries the same definitions for fresh installs.

-- ---------------------------------------------------------------------------
-- 1. Instance-level upstream registry. Trust (URL + public key + TTL) is
--    admin-managed and lives in ONE row per URL — the UNIQUE constraint makes
--    a same-URL/different-key conflict unrepresentable. Caches subscribe with
--    a per-cache mode (cache_upstream); a missing row inherits default_mode.
--    enforced=1 guarantees at least redirect participation for every cache.

CREATE TABLE IF NOT EXISTS upstream (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    public_key TEXT,
    ttl INTEGER, -- seconds; NULL = default (7 days). Doubles as query order.
    default_mode TEXT NOT NULL DEFAULT 'redirect', -- off | redirect | persist
    enforced INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_upstream (
    cache_id INTEGER NOT NULL REFERENCES cache(id),
    upstream_id INTEGER NOT NULL REFERENCES upstream(id),
    mode TEXT NOT NULL, -- off | redirect | persist
    PRIMARY KEY (cache_id, upstream_id)
);

-- Seed the registry from the union of every live cache's upstream list,
-- tolerating both the legacy plain-string and the object JSON formats.
-- MAX() arbitrates key/ttl disagreements; the save-time conflict check kept
-- production consistent, so in practice there is nothing to arbitrate.
INSERT INTO upstream (url, public_key, ttl, default_mode, enforced, created_at)
SELECT e.url, MAX(e.public_key), MAX(e.ttl), 'redirect', 0,
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM (
    SELECT rtrim(CASE WHEN j.type = 'text' THEN j.value
                      ELSE json_extract(j.value, '$.url') END, '/') AS url,
           CASE WHEN j.type = 'text' THEN NULL
                ELSE json_extract(j.value, '$.public_key') END AS public_key,
           CASE WHEN j.type = 'text' THEN NULL
                ELSE json_extract(j.value, '$.ttl') END AS ttl
    FROM cache c, json_each(c.upstream_caches) j
    WHERE c.deleted_at IS NULL
) e
WHERE e.url IS NOT NULL AND e.url <> ''
GROUP BY e.url;

-- Existing caches keep their exact behavior: an explicit mode row for every
-- (cache, upstream) pair — declared pairs keep their mode, everything else
-- is off. Registry defaults only apply to caches created after this.
INSERT OR IGNORE INTO cache_upstream (cache_id, upstream_id, mode)
SELECT c.id, u.id,
       CASE WHEN j.type <> 'text'
                 AND json_extract(j.value, '$.mode') = 'persist'
            THEN 'persist' ELSE 'redirect' END
FROM cache c, json_each(c.upstream_caches) j
JOIN upstream u ON u.url = rtrim(CASE WHEN j.type = 'text' THEN j.value
                                      ELSE json_extract(j.value, '$.url') END, '/')
WHERE c.deleted_at IS NULL;

INSERT OR IGNORE INTO cache_upstream (cache_id, upstream_id, mode)
SELECT c.id, u.id, 'off' FROM cache c CROSS JOIN upstream u
WHERE c.deleted_at IS NULL;

ALTER TABLE cache DROP COLUMN upstream_caches;

-- Re-key the verdict cache by registry id so verdicts follow the trust
-- identity (and are wiped when a key rotates). The old rows are a cache;
-- dropping them just means reads re-probe once.
DROP TABLE upstream_check;
CREATE TABLE upstream_check (
    upstream_id INTEGER NOT NULL REFERENCES upstream(id),
    store_path_hash TEXT NOT NULL,
    present INTEGER NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (upstream_id, store_path_hash)
);
-- GC's closure-integrity report probes verdicts by hash alone; without this
-- the PK (upstream_id-first) can't serve it and every run pays a scan.
CREATE INDEX idx_upstream_check_hash ON upstream_check(store_path_hash);

-- ---------------------------------------------------------------------------
-- 2. Named pins (cachix parity): a pin is a name whose gc_root rows are its
--    revision history (newest = current). Re-pinning a name adds a revision;
--    keep_revisions / keep_days prune old revisions during GC (unpin only —
--    normal retention then governs the unpinned paths).

CREATE TABLE IF NOT EXISTS pin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_id INTEGER NOT NULL REFERENCES cache(id),
    name TEXT NOT NULL,
    keep_revisions INTEGER, -- NULL = keep all revisions
    keep_days INTEGER,      -- NULL = no age limit
    created_at TEXT NOT NULL,
    UNIQUE (cache_id, name)
);

-- Rebuild gc_root: pin revisions reference their pin; anonymous quick pins
-- keep pin_id NULL. The old table-level UNIQUE(cache_id, store_path_hash)
-- becomes partial so one hash can be pinned by several names at once.
CREATE TABLE gc_root_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_id INTEGER NOT NULL REFERENCES cache(id),
    store_path_hash TEXT NOT NULL,
    note TEXT,
    pin_id INTEGER REFERENCES pin(id),
    created_at TEXT NOT NULL,
    closure_objects INTEGER,
    closure_bytes INTEGER,
    stats_at TEXT
);
INSERT INTO gc_root_new (id, cache_id, store_path_hash, note, created_at,
                         closure_objects, closure_bytes, stats_at)
SELECT id, cache_id, store_path_hash, note, created_at,
       closure_objects, closure_bytes, stats_at
FROM gc_root;
DROP TABLE gc_root;
ALTER TABLE gc_root_new RENAME TO gc_root;
CREATE UNIQUE INDEX idx_gc_root_anon ON gc_root(cache_id, store_path_hash)
    WHERE pin_id IS NULL;
CREATE UNIQUE INDEX idx_gc_root_pin ON gc_root(pin_id, store_path_hash)
    WHERE pin_id IS NOT NULL;
CREATE INDEX idx_gc_root_cache ON gc_root(cache_id);

-- ---------------------------------------------------------------------------
-- 3. Detach semantics: removing a path never deletes it while something else
--    references it. Detached objects stop anchoring retention and are reaped
--    once nothing non-detached (or pinned) can reach them.
ALTER TABLE object ADD COLUMN detached_at TEXT;

-- 4. Provenance: 'push' vs 'pullthrough:<upstream url>' (created_by rides the
--    existing column, populated with the pushing token's subject from now on).
ALTER TABLE object ADD COLUMN source TEXT;
