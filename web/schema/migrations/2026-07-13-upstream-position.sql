-- Explicit upstream query order. Until now the TTL doubled as the order
-- (longest-lived first); position decouples them so admins can reorder
-- freely. Seeded from the old effective order so behavior is unchanged.
ALTER TABLE upstream ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE upstream SET position = (
    SELECT COUNT(*) FROM upstream u2
    WHERE COALESCE(u2.ttl, 604800) > COALESCE(upstream.ttl, 604800)
       OR (COALESCE(u2.ttl, 604800) = COALESCE(upstream.ttl, 604800)
           AND u2.url < upstream.url)
);
