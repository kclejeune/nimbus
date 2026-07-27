-- Index audit: drop four indexes that cost writes and buy nothing, add one
-- that turns a nightly GC sweep into a seek. D1 bills a row written per index
-- touched, so a redundant index is a permanent tax on every write.
-- Idempotent; schema.sql carries the same state.

-- Exact duplicates of the autoindex a UNIQUE constraint already creates
-- (same columns, same order). Verified against prod query plans: the planner
-- was already choosing sqlite_autoindex_* over each of these.
--   object:      UNIQUE(cache_id, store_path_hash)  -> sqlite_autoindex_object_1
--   cache:       name TEXT NOT NULL UNIQUE          -> sqlite_autoindex_cache_1
--   device_auth: user_code TEXT NOT NULL UNIQUE     -> sqlite_autoindex_device_auth_2
-- object carried six indexes, so dropping its duplicate cuts ~14% off the
-- rows written by every object insert/upsert.
DROP INDEX IF EXISTS idx_object_cache_hash;
DROP INDEX IF EXISTS idx_cache_name;
DROP INDEX IF EXISTS idx_device_auth_user_code;

-- Never chosen. Both consumers of "dangling ref" rows -- syncObjectRefs' child
-- resolution and INCOMPLETE_CLOSURE_WHERE (gc.ts) -- are driven by the
-- `child_id IS NULL` predicate, which idx_object_ref_child serves; ref_hash
-- appears only inside correlated subqueries against object, which resolve via
-- sqlite_autoindex_object_1. Confirmed on prod for both query shapes,
-- including the GROUP BY ref_hash form where this index could plausibly have
-- saved the sort (it did not -- the plan still uses a temp b-tree).
-- object_ref is the largest table in the database, so this is the biggest
-- write saving of the four.
DROP INDEX IF EXISTS idx_object_ref_unresolved;

-- The device_auth expiry sweep was a full table scan, and device_auth is
-- written by an UNAUTHENTICATED path (the CLI device-auth start endpoint), so
-- the sweep's cost scaled with whatever an abuser inflated the table to.
-- expires_at is write-once (set at insert, never updated), so the index costs
-- one extra written row per code and nothing thereafter.
CREATE INDEX IF NOT EXISTS idx_device_auth_expires ON device_auth(expires_at);

-- Deliberately NOT indexed: upstream_check(present, checked_at), for the
-- nightly pruneUpstreamChecks scan. Run the arithmetic before adding it --
-- reads are ~1/1000th the price of writes, so an index earns its keep only
-- when it saves far more scanned rows than the writes it adds. Here it loses
-- badly: present-verdict rows live ~90 days, so the table holds roughly 90x a
-- day's writes, and the index would bill a written row for each of those
-- writes ($1.00/M) to save scanning ~90x as many rows once a night
-- ($0.001/M) -- about an order of magnitude net loss. The scan stays.
