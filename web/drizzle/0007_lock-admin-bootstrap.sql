CREATE TABLE `bootstrap_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`completed_at` integer NOT NULL,
	CONSTRAINT "bootstrap_state_singleton" CHECK("bootstrap_state"."id" = 1)
);
--> statement-breakpoint
-- Existing installations have already crossed the first-user bootstrap edge.
-- Fresh installations have no users here, so their first sign-in remains able
-- to claim ownership and insert the latch itself.
INSERT OR IGNORE INTO `bootstrap_state` (`id`, `completed_at`)
SELECT 1, unixepoch()
WHERE EXISTS (SELECT 1 FROM `user`);
