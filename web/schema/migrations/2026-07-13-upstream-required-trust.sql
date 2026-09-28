-- Trust fields are mandatory: rebuild upstream with NOT NULL public_key and
-- ttl. NULL ttl backfills to the 7-day default the code was applying anyway.
-- A keyless row cannot be backfilled (a key can't be invented), so the
-- rebuild fails loudly on one — key or remove it first.
--
-- The rebuild is safe under statement-level foreign-key enforcement (no
-- transaction assumed): the referencing tables are emptied around the parent
-- swap. cache_upstream is snapshotted and restored; upstream_check is a
-- verdict cache and simply re-warms.
--
-- Production applied this before 2026-07-13-upstream-nix-default.sql (commit
-- order), but wrangler applies in filename order, where nix-default comes
-- first; the rebuild therefore carries nix_default so a filename-order
-- application does not drop it.
UPDATE upstream SET ttl = 604800 WHERE ttl IS NULL;

CREATE TABLE cache_upstream_bak AS SELECT * FROM cache_upstream;
DELETE FROM cache_upstream;
DELETE FROM upstream_check;

CREATE TABLE upstream_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    ttl INTEGER NOT NULL, -- seconds
    default_mode TEXT NOT NULL DEFAULT 'redirect', -- off | redirect | persist
    enforced INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0, -- query order, admin-controlled
    nix_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
INSERT INTO upstream_new (id, url, public_key, ttl, default_mode, enforced, position, nix_default, created_at)
SELECT id, url, public_key, ttl, default_mode, enforced, position, nix_default, created_at FROM upstream;
DROP TABLE upstream;
ALTER TABLE upstream_new RENAME TO upstream;

INSERT INTO cache_upstream SELECT * FROM cache_upstream_bak;
DROP TABLE cache_upstream_bak;
