-- Root-proxy resolution looks up objects by store_path_hash alone
-- (cachesWithStorePathHash); the existing indexes all lead with cache_id, so
-- without this the query scans the whole object table on every root narinfo
-- request. Idempotent; also in schema.sql.
CREATE INDEX IF NOT EXISTS idx_object_hash ON object(store_path_hash);
