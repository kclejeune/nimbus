-- Rotate bounded automatic plans independently of reference discovery.
ALTER TABLE broken_purge_state ADD COLUMN purge_after_hash TEXT NOT NULL DEFAULT '';
